use std::collections::{HashMap, HashSet, VecDeque};
use std::num::NonZeroUsize;
use std::sync::{Arc, Condvar, Mutex};
use std::task::Waker;
use std::thread::{self, ThreadId};
use std::time::Instant;

use crate::events::Ended;
use crate::value::{AsValue, CallbackName};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct RunId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct CallId(u64);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CallError {
    NotRun(NotRun),
    Unknown(Unknown),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NotRun {
    Full,
    Expired,
    RunStopped,
    Closed,
    NotRegistered,
    WouldDeadlock,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Unknown {
    TimedOut,
    RunStopped,
    Closed,
    PlayerLost,
}

pub struct Run {
    shared: Arc<Shared>,
    id: RunId,
}

impl Run {
    pub fn id(&self) -> RunId {
        self.id
    }

    pub fn caller(&self) -> Caller {
        Caller {
            shared: self.shared.clone(),
            run: self.id,
        }
    }

    pub fn stop(&self) {
        let mut state = self.shared.state.lock().unwrap();
        if !state.active.remove(&self.id) {
            return;
        }
        for entry in state.entries.values_mut().filter(|e| e.run == self.id) {
            match entry.phase {
                Phase::Queued { .. } => {
                    entry.phase = Phase::Settled(Err(CallError::NotRun(NotRun::RunStopped)));
                }
                Phase::Executing => {
                    entry.phase = Phase::Settled(Err(CallError::Unknown(Unknown::RunStopped)));
                }
                Phase::Settled(_) | Phase::Abandoned => {}
            }
        }
        let State {
            entries, queued, ..
        } = &mut *state;
        queued.retain(|id| matches!(entries[id].phase, Phase::Queued { .. }));
        state.admission.retain(|ticket| ticket.run != self.id);
        state.check(self.shared.capacity);
        drop(state);
        self.shared.space.notify_all();
        self.shared.done.notify_all();
    }
}

impl Drop for Run {
    fn drop(&mut self) {
        self.stop();
    }
}

#[derive(Clone)]
pub struct Caller {
    shared: Arc<Shared>,
    run: RunId,
}

impl Caller {
    pub fn run(&self) -> RunId {
        self.run
    }

    pub fn call(
        &self,
        name: &CallbackName,
        args: Vec<AsValue>,
        deadline: Instant,
    ) -> Result<AsValue, CallError> {
        let mut state = self.shared.state.lock().unwrap();
        if !state.open {
            return Err(CallError::NotRun(NotRun::Closed));
        }
        if !state.active.contains(&self.run) {
            return Err(CallError::NotRun(NotRun::RunStopped));
        }
        if state.consumer == Some(thread::current().id()) {
            return Err(CallError::NotRun(NotRun::WouldDeadlock));
        }
        if Instant::now() >= deadline {
            return Err(CallError::NotRun(NotRun::Expired));
        }
        let ticket = state.next_ticket;
        state.next_ticket = state.next_ticket.checked_add(1).expect("ticket exhausted");
        state.admission.push_back(Ticket {
            number: ticket,
            run: self.run,
        });
        loop {
            let reason = if !state.open {
                Some(NotRun::Closed)
            } else if !state.active.contains(&self.run) {
                Some(NotRun::RunStopped)
            } else if Instant::now() >= deadline {
                Some(NotRun::Full)
            } else {
                None
            };
            if let Some(reason) = reason {
                state.admission.retain(|entry| entry.number != ticket);
                state.check(self.shared.capacity);
                drop(state);
                self.shared.space.notify_all();
                return Err(CallError::NotRun(reason));
            }
            if state.admission.front().map(|entry| entry.number) == Some(ticket)
                && state.queued.len() < self.shared.capacity
            {
                state.admission.pop_front();
                break;
            }
            state = self
                .shared
                .space
                .wait_timeout(state, deadline.saturating_duration_since(Instant::now()))
                .unwrap()
                .0;
        }
        let id = CallId(state.next_call);
        state.next_call = state.next_call.checked_add(1).expect("call id exhausted");
        state.entries.insert(
            id,
            Entry {
                run: self.run,
                deadline,
                phase: Phase::Queued {
                    name: name.clone(),
                    args,
                },
            },
        );
        state.queued.push_back(id);
        state.check(self.shared.capacity);
        drop(state);
        self.shared.space.notify_all();
        self.shared.wake.wake_by_ref();

        let mut state = self.shared.state.lock().unwrap();
        loop {
            let entry = state.entries.get_mut(&id).expect("admitted call missing");
            match &entry.phase {
                Phase::Settled(_) => {
                    let entry = state.entries.remove(&id).unwrap();
                    let Phase::Settled(result) = entry.phase else {
                        unreachable!();
                    };
                    let result = match result {
                        Ok(_) if !state.active.contains(&self.run) => {
                            Err(CallError::Unknown(Unknown::RunStopped))
                        }
                        result => result,
                    };
                    state.check(self.shared.capacity);
                    return result;
                }
                Phase::Queued { .. } if Instant::now() >= deadline => {
                    state.queued.retain(|queued| *queued != id);
                    state.entries.remove(&id);
                    state.check(self.shared.capacity);
                    drop(state);
                    self.shared.space.notify_all();
                    return Err(CallError::NotRun(NotRun::Expired));
                }
                Phase::Executing if Instant::now() >= deadline => {
                    entry.phase = Phase::Abandoned;
                    state.check(self.shared.capacity);
                    return Err(CallError::Unknown(Unknown::TimedOut));
                }
                Phase::Queued { .. } | Phase::Executing => {}
                Phase::Abandoned => unreachable!("only the waiter abandons a call"),
            }
            state = self
                .shared
                .done
                .wait_timeout(state, deadline.saturating_duration_since(Instant::now()))
                .unwrap()
                .0;
        }
    }
}

pub struct Inbox {
    shared: Arc<Shared>,
}

impl Inbox {
    pub(crate) fn new(shared: Arc<Shared>) -> Self {
        Self { shared }
    }

    pub fn bind_consumer(&self) {
        self.shared.state.lock().unwrap().consumer = Some(thread::current().id());
    }

    pub fn has_queued(&self) -> bool {
        !self.shared.state.lock().unwrap().queued.is_empty()
    }

    pub fn next(&mut self, now: Instant) -> Option<Execution> {
        let mut state = self.shared.state.lock().unwrap();
        if state.executing.is_some() {
            return None;
        }
        while let Some(id) = state.queued.pop_front() {
            self.shared.space.notify_all();
            let entry = state.entries.get_mut(&id).unwrap();
            if entry.deadline <= now.max(Instant::now()) {
                entry.phase = Phase::Settled(Err(CallError::NotRun(NotRun::Expired)));
                self.shared.done.notify_all();
                continue;
            }
            let Phase::Queued { name, args } =
                std::mem::replace(&mut entry.phase, Phase::Executing)
            else {
                unreachable!("queued call has left the queue phase");
            };
            state.executing = Some(id);
            state.check(self.shared.capacity);
            return Some(Execution {
                shared: self.shared.clone(),
                id,
                name,
                args,
                settled: false,
            });
        }
        state.check(self.shared.capacity);
        None
    }
}

impl Drop for Inbox {
    fn drop(&mut self) {
        close(&self.shared);
    }
}

#[must_use]
pub struct Execution {
    shared: Arc<Shared>,
    id: CallId,
    name: CallbackName,
    args: Vec<AsValue>,
    settled: bool,
}

impl Execution {
    pub fn name(&self) -> &CallbackName {
        &self.name
    }

    pub fn take_args(&mut self) -> Vec<AsValue> {
        std::mem::take(&mut self.args)
    }

    pub fn complete(mut self, value: AsValue) {
        self.settle(Ok(value));
    }

    pub fn refuse(mut self, reason: NotRun) {
        self.settle(Err(CallError::NotRun(reason)));
    }

    fn settle(&mut self, result: Result<AsValue, CallError>) {
        let mut state = self.shared.state.lock().unwrap();
        if state.executing == Some(self.id) {
            state.executing = None;
        }
        if let Some(entry) = state.entries.get_mut(&self.id) {
            match entry.phase {
                Phase::Executing => {
                    entry.phase =
                        Phase::Settled(if result.is_ok() && Instant::now() >= entry.deadline {
                            Err(CallError::Unknown(Unknown::TimedOut))
                        } else {
                            result
                        });
                }
                Phase::Abandoned => {
                    state.entries.remove(&self.id);
                }
                Phase::Settled(_) => {}
                Phase::Queued { .. } => unreachable!("execution returned to queue"),
            }
        }
        self.settled = true;
        state.check(self.shared.capacity);
        drop(state);
        self.shared.done.notify_all();
    }
}

impl Drop for Execution {
    fn drop(&mut self) {
        if !self.settled {
            self.settle(Err(CallError::Unknown(Unknown::PlayerLost)));
        }
    }
}

pub(crate) struct Shared {
    state: Mutex<State>,
    space: Condvar,
    done: Condvar,
    wake: Waker,
    capacity: usize,
}

impl Shared {
    pub(crate) fn new(capacity: NonZeroUsize, wake: Waker) -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                open: true,
                ..State::default()
            }),
            space: Condvar::new(),
            done: Condvar::new(),
            wake,
            capacity: capacity.get(),
        })
    }
}

#[derive(Default)]
struct State {
    open: bool,
    consumer: Option<ThreadId>,
    next_run: u64,
    next_call: u64,
    next_ticket: u64,
    active: HashSet<RunId>,
    admission: VecDeque<Ticket>,
    queued: VecDeque<CallId>,
    entries: HashMap<CallId, Entry>,
    executing: Option<CallId>,
}

impl State {
    fn check(&self, capacity: usize) {
        debug_assert!(self.queued.len() <= capacity);
        debug_assert!(self.queued.iter().all(|id| {
            self.entries.get(id).is_some_and(|entry| {
                matches!(entry.phase, Phase::Queued { .. }) && self.active.contains(&entry.run)
            })
        }));
        debug_assert!(self.entries.iter().all(|(id, entry)| {
            !matches!(entry.phase, Phase::Executing | Phase::Abandoned)
                || self.executing == Some(*id)
        }));
        debug_assert!(self.open || (self.queued.is_empty() && self.admission.is_empty()));
    }
}

struct Ticket {
    number: u64,
    run: RunId,
}

struct Entry {
    run: RunId,
    deadline: Instant,
    phase: Phase,
}

enum Phase {
    Queued {
        name: CallbackName,
        args: Vec<AsValue>,
    },
    Executing,
    Settled(Result<AsValue, CallError>),
    Abandoned,
}

pub(crate) fn begin_run(shared: &Arc<Shared>) -> Result<Run, Ended> {
    let mut state = shared.state.lock().unwrap();
    if !state.open {
        return Err(Ended);
    }
    let id = RunId(state.next_run);
    state.next_run = state.next_run.checked_add(1).expect("run id exhausted");
    state.active.insert(id);
    state.check(shared.capacity);
    Ok(Run {
        shared: shared.clone(),
        id,
    })
}

pub(crate) fn close(shared: &Shared) {
    let mut state = shared.state.lock().unwrap();
    if !state.open {
        return;
    }
    state.open = false;
    state.admission.clear();
    for entry in state.entries.values_mut() {
        match entry.phase {
            Phase::Queued { .. } => {
                entry.phase = Phase::Settled(Err(CallError::NotRun(NotRun::Closed)));
            }
            Phase::Executing => {
                entry.phase = Phase::Settled(Err(CallError::Unknown(Unknown::Closed)));
            }
            Phase::Settled(_) | Phase::Abandoned => {}
        }
    }
    state.queued.clear();
    state.check(shared.capacity);
    drop(state);
    shared.space.notify_all();
    shared.done.notify_all();
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
    use std::task::Wake;
    use std::thread::JoinHandle;
    use std::time::Duration;

    use super::*;
    use crate::{Closer, Opened, Session, SessionConfig, open};

    const NAME: CallbackName = CallbackName::from_static("player.getLevel");
    const WAIT: Duration = Duration::from_secs(2);

    #[derive(Default)]
    struct CountWake(AtomicUsize);

    impl Wake for CountWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    fn opened(capacity: usize) -> (Session, Inbox, Closer, Arc<CountWake>) {
        let wake = Arc::new(CountWake::default());
        let Opened {
            session,
            player,
            closer,
        } = open(
            SessionConfig {
                call_capacity: NonZeroUsize::new(capacity).unwrap(),
                ..SessionConfig::default()
            },
            Waker::from(wake.clone()),
        );
        (session, player.inbox, closer, wake)
    }

    struct CallTask {
        rx: Receiver<Result<AsValue, CallError>>,
        handle: JoinHandle<()>,
    }

    impl CallTask {
        fn result(self) -> Result<AsValue, CallError> {
            let result = self.rx.recv_timeout(WAIT).expect("call did not settle");
            self.handle.join().unwrap();
            assert_eq!(self.rx.try_recv(), Err(TryRecvError::Disconnected));
            result
        }
    }

    fn submit(caller: Caller, value: f64, deadline: Instant) -> CallTask {
        let (tx, rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            tx.send(caller.call(&NAME, vec![AsValue::Number(value)], deadline))
                .unwrap();
        });
        CallTask { rx, handle }
    }

    fn wait_for(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + WAIT;
        while !ready() {
            assert!(
                Instant::now() < deadline,
                "queue did not reach test barrier"
            );
            thread::yield_now();
        }
    }

    fn queued(inbox: &Inbox, count: usize) {
        wait_for(|| inbox.shared.state.lock().unwrap().queued.len() == count);
    }

    fn admission(inbox: &Inbox, count: usize) {
        wait_for(|| inbox.shared.state.lock().unwrap().admission.len() == count);
    }

    fn next(inbox: &mut Inbox) -> Execution {
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(execution) = inbox.next(Instant::now()) {
                return execution;
            }
            assert!(Instant::now() < deadline, "consumer received no call");
            thread::yield_now();
        }
    }

    #[test]
    fn a_call_wakes_the_consumer_once_per_admission() {
        let (session, mut inbox, _, wake) = opened(3);
        let run = session.begin_run().unwrap();
        let calls: Vec<_> = (0..3)
            .map(|value| {
                let call = submit(run.caller(), f64::from(value), Instant::now() + WAIT);
                queued(&inbox, value as usize + 1);
                call
            })
            .collect();
        wait_for(|| wake.0.load(Ordering::SeqCst) == 3);
        assert_eq!(wake.0.load(Ordering::SeqCst), 3);
        for _ in 0..3 {
            next(&mut inbox).complete(AsValue::Number(42.0));
        }
        for call in calls {
            assert_eq!(call.result(), Ok(AsValue::Number(42.0)));
        }
        assert_eq!(wake.0.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn executes_in_admission_order_across_threads() {
        let (session, inbox, _, _) = opened(8);
        let run = session.begin_run().unwrap();
        let calls: Vec<_> = (0..8)
            .map(|value| {
                let call = submit(run.caller(), f64::from(value), Instant::now() + WAIT);
                queued(&inbox, value as usize + 1);
                call
            })
            .collect();
        let consumer = thread::spawn(move || {
            let mut inbox = inbox;
            inbox.bind_consumer();
            let mut values = Vec::new();
            for _ in 0..8 {
                let mut execution = next(&mut inbox);
                assert_eq!(execution.name().as_str(), "player.getLevel");
                let args = execution.take_args();
                assert_eq!(execution.take_args(), Vec::<AsValue>::new());
                values.extend(args);
                execution.complete(AsValue::Bool(true));
            }
            (inbox, values)
        });
        for call in calls {
            assert_eq!(call.result(), Ok(AsValue::Bool(true)));
        }
        let (_, values) = consumer.join().unwrap();
        assert_eq!(
            values,
            vec![
                AsValue::Number(0.0),
                AsValue::Number(1.0),
                AsValue::Number(2.0),
                AsValue::Number(3.0),
                AsValue::Number(4.0),
                AsValue::Number(5.0),
                AsValue::Number(6.0),
                AsValue::Number(7.0),
            ]
        );
    }

    #[test]
    fn full_queue_waits_until_the_deadline_then_returns_full() {
        let (session, inbox, closer, wake) = opened(1);
        let run = session.begin_run().unwrap();
        let first = submit(run.caller(), 0.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        let deadline = Instant::now() + Duration::from_millis(40);
        let caller = run.caller();
        let second = thread::spawn(move || {
            let result = caller.call(&NAME, vec![AsValue::Number(1.0)], deadline);
            (result, Instant::now())
        });
        let (result, returned) = second.join().unwrap();
        assert_eq!(result, Err(CallError::NotRun(NotRun::Full)));
        assert!(returned >= deadline);
        assert!(returned.duration_since(deadline) < Duration::from_secs(1));
        assert_eq!(wake.0.load(Ordering::SeqCst), 1);
        closer.close();
        assert_eq!(first.result(), Err(CallError::NotRun(NotRun::Closed)));
    }

    #[test]
    fn waiting_callers_are_admitted_in_ticket_order() {
        let (session, mut inbox, _, _) = opened(1);
        let run = session.begin_run().unwrap();
        let mut calls = vec![submit(run.caller(), 0.0, Instant::now() + WAIT)];
        queued(&inbox, 1);
        for value in 1..5 {
            calls.push(submit(
                run.caller(),
                f64::from(value),
                Instant::now() + WAIT,
            ));
            admission(&inbox, value as usize);
        }
        let mut seen = Vec::new();
        for _ in 0..5 {
            let mut execution = next(&mut inbox);
            seen.extend(execution.take_args());
            execution.complete(AsValue::Number(42.0));
        }
        assert_eq!(
            seen,
            vec![
                AsValue::Number(0.0),
                AsValue::Number(1.0),
                AsValue::Number(2.0),
                AsValue::Number(3.0),
                AsValue::Number(4.0),
            ]
        );
        for call in calls {
            assert_eq!(call.result(), Ok(AsValue::Number(42.0)));
        }
    }

    #[test]
    fn admitted_calls_settle_once_under_a_seeded_mix_of_terminal_actions() {
        let mut seed = 0x8c03_b4e9_u64;
        let mut exercised = [false; 8];
        for _ in 0..64 {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
            let action = ((seed >> 32) % 8) as usize;
            exercised[action] = true;
            let (session, mut inbox, closer, wake) = opened(2);
            let run = session.begin_run().unwrap();
            let other_run = session.begin_run().unwrap();
            let deadline = Instant::now() + Duration::from_millis(40);
            let first = submit(
                run.caller(),
                0.0,
                if action == 6 {
                    deadline
                } else {
                    Instant::now() + WAIT
                },
            );
            let mut execution = next(&mut inbox);
            let mut executed = execution.take_args();
            assert_eq!(executed, vec![AsValue::Number(0.0)]);
            let follower = if action == 4 {
                other_run.caller()
            } else {
                run.caller()
            };
            let second = submit(
                follower.clone(),
                1.0,
                if action == 3 {
                    deadline
                } else {
                    Instant::now() + WAIT
                },
            );
            queued(&inbox, 1);
            let third = submit(
                follower,
                2.0,
                if action == 3 {
                    deadline
                } else {
                    Instant::now() + WAIT
                },
            );
            queued(&inbox, 2);
            assert!(inbox.next(Instant::now()).is_none());
            match action {
                0 => execution.complete(AsValue::Number(42.0)),
                1 | 4 => {
                    run.stop();
                    run.stop();
                    assert!(inbox.next(Instant::now()).is_none());
                    execution.complete(AsValue::Number(99.0));
                }
                2 | 5 => {
                    closer.close();
                    closer.close();
                    if action == 5 {
                        run.stop();
                    }
                    execution.complete(AsValue::Number(99.0));
                }
                3 => {
                    queued(&inbox, 0);
                    execution.complete(AsValue::Number(42.0));
                }
                6 => {
                    wait_for(|| {
                        inbox
                            .shared
                            .state
                            .lock()
                            .unwrap()
                            .entries
                            .values()
                            .any(|entry| matches!(entry.phase, Phase::Abandoned))
                    });
                    run.stop();
                    closer.close();
                    assert!(inbox.next(Instant::now()).is_none());
                    execution.complete(AsValue::Number(99.0));
                }
                7 => drop(execution),
                _ => unreachable!(),
            }
            if action == 0 || action == 4 || action == 7 {
                for _ in 0..2 {
                    let mut execution = next(&mut inbox);
                    executed.extend(execution.take_args());
                    assert!(inbox.next(Instant::now()).is_none());
                    execution.complete(AsValue::Number(42.0));
                }
                assert_eq!(
                    executed,
                    vec![
                        AsValue::Number(0.0),
                        AsValue::Number(1.0),
                        AsValue::Number(2.0),
                    ]
                );
            } else {
                assert_eq!(executed, vec![AsValue::Number(0.0)]);
            }
            let outcomes = (first.result(), second.result(), third.result());
            match action {
                0 => assert_eq!(
                    outcomes,
                    (
                        Ok(AsValue::Number(42.0)),
                        Ok(AsValue::Number(42.0)),
                        Ok(AsValue::Number(42.0)),
                    )
                ),
                1 => assert_eq!(
                    outcomes,
                    (
                        Err(CallError::Unknown(Unknown::RunStopped)),
                        Err(CallError::NotRun(NotRun::RunStopped)),
                        Err(CallError::NotRun(NotRun::RunStopped)),
                    )
                ),
                2 | 5 => assert_eq!(
                    outcomes,
                    (
                        Err(CallError::Unknown(Unknown::Closed)),
                        Err(CallError::NotRun(NotRun::Closed)),
                        Err(CallError::NotRun(NotRun::Closed)),
                    )
                ),
                3 => assert_eq!(
                    outcomes,
                    (
                        Ok(AsValue::Number(42.0)),
                        Err(CallError::NotRun(NotRun::Expired)),
                        Err(CallError::NotRun(NotRun::Expired)),
                    )
                ),
                4 => assert_eq!(
                    outcomes,
                    (
                        Err(CallError::Unknown(Unknown::RunStopped)),
                        Ok(AsValue::Number(42.0)),
                        Ok(AsValue::Number(42.0)),
                    )
                ),
                6 => assert_eq!(
                    outcomes,
                    (
                        Err(CallError::Unknown(Unknown::TimedOut)),
                        Err(CallError::NotRun(NotRun::RunStopped)),
                        Err(CallError::NotRun(NotRun::RunStopped)),
                    )
                ),
                7 => assert_eq!(
                    outcomes,
                    (
                        Err(CallError::Unknown(Unknown::PlayerLost)),
                        Ok(AsValue::Number(42.0)),
                        Ok(AsValue::Number(42.0)),
                    )
                ),
                _ => unreachable!(),
            }
            assert!(!inbox.has_queued());
            assert!(inbox.next(Instant::now()).is_none());
            assert_eq!(wake.0.load(Ordering::SeqCst), 3);
            assert!(inbox.shared.state.lock().unwrap().entries.is_empty());
        }
        assert_eq!(exercised, [true, true, true, true, true, true, true, true]);
    }

    #[test]
    fn a_call_executes_at_most_once_and_only_one_execution_can_be_live() {
        let (session, mut inbox, _, _) = opened(2);
        let run = session.begin_run().unwrap();
        let first = submit(run.caller(), 1.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        let second = submit(run.caller(), 2.0, Instant::now() + WAIT);
        queued(&inbox, 2);
        let mut first_execution = next(&mut inbox);
        assert_eq!(first_execution.take_args(), vec![AsValue::Number(1.0)]);
        assert!(inbox.next(Instant::now()).is_none());
        first_execution.complete(AsValue::Number(10.0));
        let mut second_execution = next(&mut inbox);
        assert_eq!(second_execution.take_args(), vec![AsValue::Number(2.0)]);
        assert!(inbox.next(Instant::now()).is_none());
        second_execution.complete(AsValue::Number(20.0));
        assert_eq!(first.result(), Ok(AsValue::Number(10.0)));
        assert_eq!(second.result(), Ok(AsValue::Number(20.0)));
        assert!(inbox.next(Instant::now()).is_none());
        run.stop();
        assert!(inbox.next(Instant::now()).is_none());
    }

    #[test]
    fn stop_releases_queued_and_running_calls_while_the_consumer_is_blocked() {
        let (session, inbox, _, _) = opened(1);
        let run = session.begin_run().unwrap();
        let running = submit(run.caller(), 0.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        let (started_tx, started_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let consumer = thread::spawn(move || {
            let mut inbox = inbox;
            inbox.bind_consumer();
            let execution = next(&mut inbox);
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(WAIT).unwrap();
            execution.complete(AsValue::Number(99.0));
            inbox
        });
        started_rx.recv_timeout(WAIT).unwrap();
        let waiting = submit(run.caller(), 1.0, Instant::now() + WAIT);
        wait_for(|| session.calls.state.lock().unwrap().queued.len() == 1);
        let start = Instant::now();
        run.stop();
        assert_eq!(
            running.result(),
            Err(CallError::Unknown(Unknown::RunStopped))
        );
        assert_eq!(waiting.result(), Err(CallError::NotRun(NotRun::RunStopped)));
        assert!(start.elapsed() < Duration::from_millis(250));
        release_tx.send(()).unwrap();
        let mut inbox = consumer.join().unwrap();
        assert!(inbox.next(Instant::now()).is_none());
    }

    #[test]
    fn stop_releases_callers_waiting_for_space() {
        let (session, inbox, _, _) = opened(1);
        let run = session.begin_run().unwrap();
        let first = submit(run.caller(), 0.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        let second = submit(run.caller(), 1.0, Instant::now() + WAIT);
        admission(&inbox, 1);
        run.stop();
        run.stop();
        assert_eq!(first.result(), Err(CallError::NotRun(NotRun::RunStopped)));
        assert_eq!(second.result(), Err(CallError::NotRun(NotRun::RunStopped)));
        assert_eq!(
            run.caller().call(&NAME, vec![], Instant::now() + WAIT),
            Err(CallError::NotRun(NotRun::RunStopped))
        );
    }

    #[test]
    fn a_result_completed_after_stop_is_discarded() {
        let (session, mut inbox, _, _) = opened(1);
        let stopped_run = session.begin_run().unwrap();
        let stopped = submit(stopped_run.caller(), 0.0, Instant::now() + WAIT);
        let execution = next(&mut inbox);
        stopped_run.stop();
        assert_eq!(
            stopped.result(),
            Err(CallError::Unknown(Unknown::RunStopped))
        );
        let active_run = session.begin_run().unwrap();
        let active = submit(active_run.caller(), 1.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        assert!(inbox.next(Instant::now()).is_none());
        execution.complete(AsValue::Number(99.0));
        next(&mut inbox).complete(AsValue::Number(42.0));
        assert_eq!(active.result(), Ok(AsValue::Number(42.0)));
    }

    struct GateWake {
        entered: Sender<()>,
        release: Mutex<Receiver<()>>,
    }

    impl Wake for GateWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            self.entered.send(()).unwrap();
            self.release.lock().unwrap().recv_timeout(WAIT).unwrap();
        }
    }

    fn gated() -> (Session, Inbox, Closer, Receiver<()>, Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let opened = open(
            SessionConfig::default(),
            Waker::from(Arc::new(GateWake {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            })),
        );
        (
            opened.session,
            opened.player.inbox,
            opened.closer,
            entered_rx,
            release_tx,
        )
    }

    #[test]
    fn a_success_read_after_stop_becomes_unknown_even_if_completed_before_stop() {
        let (session, mut inbox, closer, entered, release) = gated();
        let run = session.begin_run().unwrap();
        let call = submit(run.caller(), 0.0, Instant::now() + WAIT);
        entered.recv_timeout(WAIT).unwrap();
        next(&mut inbox).complete(AsValue::Number(42.0));
        run.stop();
        closer.close();
        release.send(()).unwrap();
        assert_eq!(call.result(), Err(CallError::Unknown(Unknown::RunStopped)));
    }

    #[test]
    fn an_unread_settled_error_is_not_overwritten_by_stop_or_close() {
        let (session, mut inbox, closer, entered, release) = gated();
        let run = session.begin_run().unwrap();
        let call = submit(run.caller(), 0.0, Instant::now() + WAIT);
        entered.recv_timeout(WAIT).unwrap();
        next(&mut inbox).refuse(NotRun::NotRegistered);
        run.stop();
        closer.close();
        release.send(()).unwrap();
        assert_eq!(call.result(), Err(CallError::NotRun(NotRun::NotRegistered)));
    }

    #[test]
    fn expired_calls_are_withdrawn_before_they_start() {
        let (session, mut inbox, _, wake) = opened(1);
        let run = session.begin_run().unwrap();
        let call = submit(
            run.caller(),
            0.0,
            Instant::now() + Duration::from_millis(20),
        );
        queued(&inbox, 1);
        assert_eq!(call.result(), Err(CallError::NotRun(NotRun::Expired)));
        assert!(inbox.next(Instant::now()).is_none());
        assert_eq!(wake.0.load(Ordering::SeqCst), 1);
        assert_eq!(
            run.caller().call(&NAME, vec![], Instant::now()),
            Err(CallError::NotRun(NotRun::Expired))
        );
        assert_eq!(wake.0.load(Ordering::SeqCst), 1);
        let active = submit(run.caller(), 1.0, Instant::now() + WAIT);
        next(&mut inbox).complete(AsValue::Number(42.0));
        assert_eq!(active.result(), Ok(AsValue::Number(42.0)));
    }

    #[test]
    fn the_consumer_withdraws_expired_calls_before_starting_them() {
        let (session, mut inbox, _, entered, release) = gated();
        let run = session.begin_run().unwrap();
        let deadline = Instant::now() + Duration::from_millis(20);
        let call = submit(run.caller(), 0.0, deadline);
        entered.recv_timeout(WAIT).unwrap();
        assert!(inbox.next(deadline).is_none());
        release.send(()).unwrap();
        assert_eq!(call.result(), Err(CallError::NotRun(NotRun::Expired)));
    }

    #[test]
    fn a_stale_consumer_time_cannot_start_an_expired_call() {
        let (session, mut inbox, _, entered, release) = gated();
        let run = session.begin_run().unwrap();
        let stale = Instant::now();
        let deadline = stale + Duration::from_millis(40);
        let call = submit(run.caller(), 0.0, deadline);
        entered.recv_timeout(WAIT).unwrap();
        wait_for(|| Instant::now() >= deadline);
        assert!(inbox.next(stale).is_none());
        release.send(()).unwrap();
        assert_eq!(call.result(), Err(CallError::NotRun(NotRun::Expired)));
    }

    #[test]
    fn a_late_refusal_retains_its_not_run_reason() {
        let (session, mut inbox, _, entered, release) = gated();
        let run = session.begin_run().unwrap();
        let deadline = Instant::now() + Duration::from_millis(40);
        let call = submit(run.caller(), 0.0, deadline);
        entered.recv_timeout(WAIT).unwrap();
        let execution = next(&mut inbox);
        wait_for(|| Instant::now() >= deadline);
        execution.refuse(NotRun::NotRegistered);
        release.send(()).unwrap();
        assert_eq!(call.result(), Err(CallError::NotRun(NotRun::NotRegistered)));
    }

    #[test]
    fn a_late_execution_drop_retains_player_lost() {
        let (session, mut inbox, _, entered, release) = gated();
        let run = session.begin_run().unwrap();
        let deadline = Instant::now() + Duration::from_millis(40);
        let call = submit(run.caller(), 0.0, deadline);
        entered.recv_timeout(WAIT).unwrap();
        let execution = next(&mut inbox);
        wait_for(|| Instant::now() >= deadline);
        drop(execution);
        release.send(()).unwrap();
        assert_eq!(call.result(), Err(CallError::Unknown(Unknown::PlayerLost)));
    }

    #[test]
    fn an_executing_timeout_keeps_the_slot_until_the_late_completion() {
        let (session, mut inbox, _, _) = opened(1);
        let run = session.begin_run().unwrap();
        let expired = submit(
            run.caller(),
            0.0,
            Instant::now() + Duration::from_millis(20),
        );
        let execution = next(&mut inbox);
        assert_eq!(expired.result(), Err(CallError::Unknown(Unknown::TimedOut)));
        let active = submit(run.caller(), 1.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        assert!(inbox.next(Instant::now()).is_none());
        execution.complete(AsValue::Number(99.0));
        next(&mut inbox).complete(AsValue::Number(42.0));
        assert_eq!(active.result(), Ok(AsValue::Number(42.0)));
    }

    #[test]
    fn a_completion_past_deadline_does_not_win_against_a_delayed_waiter() {
        let (session, mut inbox, _, entered, release) = gated();
        let run = session.begin_run().unwrap();
        let deadline = Instant::now() + Duration::from_millis(20);
        let call = submit(run.caller(), 0.0, deadline);
        entered.recv_timeout(WAIT).unwrap();
        let execution = next(&mut inbox);
        wait_for(|| Instant::now() >= deadline);
        execution.complete(AsValue::Number(99.0));
        release.send(()).unwrap();
        assert_eq!(call.result(), Err(CallError::Unknown(Unknown::TimedOut)));
    }

    #[test]
    fn calls_from_the_consumer_thread_fail_with_would_deadlock() {
        let (session, inbox, _, wake) = opened(1);
        let run = session.begin_run().unwrap();
        inbox.bind_consumer();
        let started = Instant::now();
        assert_eq!(
            run.caller().call(&NAME, vec![], Instant::now() + WAIT),
            Err(CallError::NotRun(NotRun::WouldDeadlock))
        );
        assert!(started.elapsed() < Duration::from_millis(250));
        assert_eq!(wake.0.load(Ordering::SeqCst), 0);
        let other = submit(run.caller(), 1.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        run.stop();
        assert_eq!(other.result(), Err(CallError::NotRun(NotRun::RunStopped)));
        assert_eq!(wake.0.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn dropping_an_execution_settles_it_as_player_lost() {
        let (session, mut inbox, _, _) = opened(1);
        let run = session.begin_run().unwrap();
        let call = submit(run.caller(), 0.0, Instant::now() + WAIT);
        drop(next(&mut inbox));
        assert_eq!(call.result(), Err(CallError::Unknown(Unknown::PlayerLost)));
        let next_call = submit(run.caller(), 1.0, Instant::now() + WAIT);
        next(&mut inbox).complete(AsValue::Number(42.0));
        assert_eq!(next_call.result(), Ok(AsValue::Number(42.0)));
    }

    #[test]
    fn close_releases_everything_and_rejects_new_runs() {
        let (session, mut inbox, closer, _) = opened(1);
        let run = session.begin_run().unwrap();
        let running = submit(run.caller(), 0.0, Instant::now() + WAIT);
        let execution = next(&mut inbox);
        let queued_call = submit(run.caller(), 1.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        let admission_call = submit(run.caller(), 2.0, Instant::now() + WAIT);
        admission(&inbox, 1);
        thread::spawn(move || {
            closer.close();
            closer.close();
        })
        .join()
        .unwrap();
        assert_eq!(running.result(), Err(CallError::Unknown(Unknown::Closed)));
        assert_eq!(queued_call.result(), Err(CallError::NotRun(NotRun::Closed)));
        assert_eq!(
            admission_call.result(),
            Err(CallError::NotRun(NotRun::Closed))
        );
        assert!(matches!(session.begin_run(), Err(Ended)));
        assert_eq!(
            run.caller().call(&NAME, vec![], Instant::now() + WAIT),
            Err(CallError::NotRun(NotRun::Closed))
        );
        execution.complete(AsValue::Number(99.0));
        assert!(inbox.next(Instant::now()).is_none());
    }

    #[test]
    fn dropping_the_inbox_closes_the_session() {
        let (session, inbox, _, _) = opened(1);
        let run = session.begin_run().unwrap();
        let call = submit(run.caller(), 0.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        drop(inbox);
        assert_eq!(call.result(), Err(CallError::NotRun(NotRun::Closed)));
        assert!(matches!(session.begin_run(), Err(Ended)));
    }

    #[test]
    fn dropping_a_run_stops_it_and_leaves_other_runs_active() {
        let (session, mut inbox, _, _) = opened(2);
        let stopped_run = session.begin_run().unwrap();
        let active_run = session.begin_run().unwrap();
        let caller = stopped_run.caller();
        assert_eq!(caller.run(), stopped_run.id());
        assert_ne!(stopped_run.id(), active_run.id());
        let stopped = submit(caller.clone(), 0.0, Instant::now() + WAIT);
        queued(&inbox, 1);
        let active = submit(active_run.caller(), 1.0, Instant::now() + WAIT);
        queued(&inbox, 2);
        drop(stopped_run);
        assert_eq!(stopped.result(), Err(CallError::NotRun(NotRun::RunStopped)));
        assert_eq!(
            caller.call(&NAME, vec![], Instant::now() + WAIT),
            Err(CallError::NotRun(NotRun::RunStopped))
        );
        let mut execution = next(&mut inbox);
        assert_eq!(execution.take_args(), vec![AsValue::Number(1.0)]);
        execution.complete(AsValue::Number(42.0));
        assert_eq!(active.result(), Ok(AsValue::Number(42.0)));
    }
}
