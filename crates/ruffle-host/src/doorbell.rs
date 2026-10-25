use std::sync::{Arc, Condvar, Mutex};
use std::task::Wake;
use std::time::Instant;

// A condvar rather than thread::park: wgpu polling and std channels park the player
// thread internally and would consume a park token.
pub(crate) struct Doorbell {
    rung: Mutex<bool>,
    bell: Condvar,
}

impl Doorbell {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            rung: Mutex::new(false),
            bell: Condvar::new(),
        })
    }

    pub(crate) fn ring(&self) {
        *self.rung.lock().unwrap() = true;
        self.bell.notify_one();
    }

    pub(crate) fn wait_until(&self, deadline: Instant) {
        let mut rung = self.rung.lock().unwrap();
        while !*rung {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            rung = self.bell.wait_timeout(rung, deadline - now).unwrap().0;
        }
        *rung = false;
    }
}

impl Wake for Doorbell {
    fn wake(self: Arc<Self>) {
        self.ring();
    }

    fn wake_by_ref(self: &Arc<Self>) {
        self.ring();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn a_ring_before_the_wait_returns_at_once() {
        let bell = Doorbell::new();
        bell.ring();
        let start = Instant::now();
        bell.wait_until(start + Duration::from_secs(5));
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    #[test]
    fn a_ring_from_another_thread_ends_the_wait() {
        let bell = Doorbell::new();
        let ringer = bell.clone();
        let start = Instant::now();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            ringer.ring();
        });
        bell.wait_until(start + Duration::from_secs(5));
        thread.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn waits_until_the_deadline_without_a_ring() {
        let bell = Doorbell::new();
        let start = Instant::now();
        bell.wait_until(start + Duration::from_millis(30));
        assert!(start.elapsed() >= Duration::from_millis(30));
    }
}
