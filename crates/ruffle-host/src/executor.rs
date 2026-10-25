use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Instant;

use ruffle_core::backend::navigator::OwnedFuture;
use ruffle_core::loader::Error as LoaderError;

use crate::doorbell::Doorbell;

pub(crate) struct LocalExecutor {
    ready: mpsc::Receiver<async_task::Runnable>,
    spawner: LocalSpawner,
}

#[derive(Clone)]
pub(crate) struct LocalSpawner {
    ready: mpsc::Sender<async_task::Runnable>,
    doorbell: Arc<Doorbell>,
    leaked: Arc<AtomicUsize>,
}

impl LocalExecutor {
    pub(crate) fn new(doorbell: Arc<Doorbell>) -> Self {
        let (ready, rx) = mpsc::channel();
        Self {
            ready: rx,
            spawner: LocalSpawner {
                ready,
                doorbell,
                leaked: Arc::new(AtomicUsize::new(0)),
            },
        }
    }

    pub(crate) fn spawner(&self) -> LocalSpawner {
        self.spawner.clone()
    }

    pub(crate) fn run_ready(&self, budget_end: Instant) -> bool {
        while let Ok(runnable) = self.ready.try_recv() {
            runnable.run();
            if Instant::now() >= budget_end {
                return true;
            }
        }
        false
    }

    pub(crate) fn drain(self, deadline: Instant) -> usize {
        self.run_ready(deadline);
        let leaked = self.spawner.leaked.clone();
        drop(self);
        leaked.load(Ordering::Relaxed)
    }
}

impl LocalSpawner {
    pub(crate) fn spawn(&self, future: OwnedFuture<(), LoaderError>) {
        let future = async move {
            if let Err(error) = future.await {
                tracing::warn!(%error, "player task failed");
            }
        };
        let ready = self.ready.clone();
        let doorbell = self.doorbell.clone();
        let leaked = self.leaked.clone();
        let schedule = move |runnable| match ready.send(runnable) {
            Ok(()) => doorbell.ring(),
            // A local task dropped off its thread panics, so a task woken after shutdown is leaked.
            Err(mpsc::SendError(runnable)) => {
                std::mem::forget(runnable);
                leaked.fetch_add(1, Ordering::Relaxed);
            }
        };
        let (runnable, task) = async_task::spawn_local(future, schedule);
        task.detach();
        runnable.schedule();
    }
}
