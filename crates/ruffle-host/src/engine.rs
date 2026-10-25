use std::sync::Arc;
use std::time::Duration;

use ruffle_render_wgpu::backend::{create_wgpu_instance, request_adapter_and_device};
use ruffle_render_wgpu::descriptors::Descriptors;
use ruffle_render_wgpu::wgpu;

#[derive(Clone)]
pub struct Engine {
    pub(crate) inner: Arc<EngineInner>,
}

pub(crate) struct EngineInner {
    pub(crate) net: tokio::runtime::Runtime,
    pub(crate) gpu: Arc<Descriptors>,
}

#[derive(Debug)]
pub enum EngineError {
    Runtime(std::io::Error),
    Gpu(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Runtime(error) => {
                write!(f, "could not start the network runtime: {error}")
            }
            EngineError::Gpu(error) => write!(f, "could not open a graphics device: {error}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl Engine {
    pub fn start() -> Result<Engine, EngineError> {
        let net = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .thread_name("lucent-net")
            .enable_io()
            .enable_time()
            .build()
            .map_err(EngineError::Runtime)?;
        let backends = wgpu::Backends::PRIMARY;
        let instance = create_wgpu_instance(backends, wgpu::BackendOptions::default(), None);
        let (adapter, device, queue) = futures::executor::block_on(request_adapter_and_device(
            backends,
            &instance,
            None,
            wgpu::PowerPreference::LowPower,
        ))
        .map_err(|error| EngineError::Gpu(error.to_string()))?;
        let gpu = Arc::new(Descriptors::new(instance, adapter, device, queue));
        Ok(Engine {
            inner: Arc::new(EngineInner { net, gpu }),
        })
    }

    pub fn stop(self, timeout: Duration) {
        match Arc::try_unwrap(self.inner) {
            Ok(inner) => inner.net.shutdown_timeout(timeout),
            Err(_) => tracing::error!("engine stopped while a player still holds it"),
        }
    }
}
