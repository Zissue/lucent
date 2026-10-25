#![allow(dead_code)]

use std::path::Path;
use std::time::{Duration, Instant};

use bridge::{Boot, Session};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Resources {
    pub threads: usize,
    pub sockets: usize,
    pub open_files: usize,
}

#[cfg(target_os = "macos")]
pub fn resources() -> Resources {
    use std::mem::size_of;
    let pid = std::process::id() as libc::c_int;
    let mut task: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = size_of::<libc::proc_taskinfo>() as libc::c_int;
    let read =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTASKINFO, 0, (&raw mut task).cast(), size) };
    assert_eq!(read, size, "proc_pidinfo(PROC_PIDTASKINFO) failed");
    let needed =
        unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDLISTFDS, 0, std::ptr::null_mut(), 0) };
    assert!(needed > 0, "proc_pidinfo(PROC_PIDLISTFDS) failed");
    let capacity = needed as usize / size_of::<libc::proc_fdinfo>() + 32;
    let mut fds: Vec<libc::proc_fdinfo> = vec![unsafe { std::mem::zeroed() }; capacity];
    let bytes = (capacity * size_of::<libc::proc_fdinfo>()) as libc::c_int;
    let used = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr().cast(),
            bytes,
        )
    };
    assert!(used >= 0, "proc_pidinfo(PROC_PIDLISTFDS) failed");
    fds.truncate(used as usize / size_of::<libc::proc_fdinfo>());
    let count = |kind: libc::c_int| {
        fds.iter()
            .filter(|fd| fd.proc_fdtype == kind as u32)
            .count()
    };
    Resources {
        threads: task.pti_threadnum as usize,
        sockets: count(libc::PROX_FDTYPE_SOCKET),
        open_files: count(libc::PROX_FDTYPE_VNODE),
    }
}

#[cfg(target_os = "linux")]
pub fn resources() -> Resources {
    let count = |dir: &str| {
        std::fs::read_dir(dir)
            .map(|entries| entries.count())
            .unwrap_or(0)
    };
    let links: Vec<String> = std::fs::read_dir("/proc/self/fd")
        .unwrap()
        .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
        .map(|target| target.to_string_lossy().into_owned())
        .collect();
    Resources {
        threads: count("/proc/self/task"),
        sockets: links
            .iter()
            .filter(|target| target.starts_with("socket:"))
            .count(),
        open_files: links
            .iter()
            .filter(|target| target.starts_with('/'))
            .count(),
    }
}

pub fn files_in(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .map(|entries| entries.count())
        .unwrap_or(0)
}

pub fn wait_for_boot(session: &Session, timeout: Duration) -> Boot {
    let deadline = Instant::now() + timeout;
    loop {
        let boot = session.status().boot;
        if matches!(boot, Boot::Ready | Boot::Failed { .. }) || Instant::now() >= deadline {
            return boot;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn percentile(sorted: &[Duration], fraction: f64) -> Duration {
    let index = ((sorted.len() as f64 - 1.0) * fraction).round() as usize;
    sorted[index]
}
