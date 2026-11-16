use jni::{
    JNIEnv,
    objects::{JObject, JString, JValue},
    sys::jstring,
};
use std::sync::atomic::{AtomicBool, Ordering};

static CANCELLED: AtomicBool = AtomicBool::new(false);
static RUNNING: AtomicBool = AtomicBool::new(false);

#[unsafe(no_mangle)]
pub extern "system" fn Java_soy_napplet_fipsdemo_MainActivity_nativePrepare(
    _: JNIEnv,
    _: JObject,
) -> jni::sys::jboolean {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return 0;
    }
    CANCELLED.store(false, Ordering::SeqCst);
    1
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_soy_napplet_fipsdemo_MainActivity_nativeCancel(_: JNIEnv, _: JObject) {
    CANCELLED.store(true, Ordering::SeqCst);
}

#[unsafe(no_mangle)]
pub extern "system" fn Java_soy_napplet_fipsdemo_MainActivity_nativeFetch(
    mut env: JNIEnv,
    activity: JObject,
    input: JString,
) -> jstring {
    let output = {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || -> anyhow::Result<serde_json::Value> {
                let input: String = env.get_string(&input)?.into();
                let request: super::Request = serde_json::from_str(&input)?;
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()?;
                runtime.block_on(super::fetch(&request, &CANCELLED, |event| {
                    if let Ok(text) = env.new_string(event.to_string()) {
                        if env
                            .call_method(
                                &activity,
                                "onNativeProgress",
                                "(Ljava/lang/String;)V",
                                &[JValue::Object(&text)],
                            )
                            .is_err()
                        {
                            let _ = env.exception_clear();
                            CANCELLED.store(true, Ordering::SeqCst);
                        }
                    }
                }))
            },
        ));
        RUNNING.store(false, Ordering::SeqCst);
        match result {
            Ok(Ok(value)) => value,
            Ok(Err(error)) => {
                serde_json::json!({"stage":if CANCELLED.load(Ordering::SeqCst) { "cancelled" } else { "error" }, "message":format!("{error:#}")})
            }
            Err(_) => {
                serde_json::json!({"stage":"error", "message":"Native transport stopped unexpectedly; retry the connection"})
            }
        }
    };
    env.new_string(output.to_string())
        .map(|s| s.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

// Separate state from the retained transport lab. The WebView cannot open peers or select roots.
static ATLAS_CANCEL: AtomicBool = AtomicBool::new(true);
static ATLAS_RUNNING: AtomicBool = AtomicBool::new(false);
static ATLAS_QUEUE: std::sync::Mutex<Option<std::sync::mpsc::SyncSender<crate::atlas::Input>>> =
    std::sync::Mutex::new(None);
#[unsafe(no_mangle)]
pub extern "system" fn Java_soy_napplet_fipsdemo_AtlasActivity_nativePrepare(
    _: JNIEnv,
    _: JObject,
) -> jni::sys::jboolean {
    if ATLAS_RUNNING.swap(true, Ordering::SeqCst) {
        return 0;
    }
    ATLAS_CANCEL.store(false, Ordering::SeqCst);
    1
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_soy_napplet_fipsdemo_AtlasActivity_nativeClose(_: JNIEnv, _: JObject) {
    ATLAS_CANCEL.store(true, Ordering::SeqCst);
    if let Ok(mut q) = ATLAS_QUEUE.lock() {
        *q = None;
    }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_soy_napplet_fipsdemo_AtlasActivity_nativeSubmit(
    mut env: JNIEnv,
    _: JObject,
    input: JString,
    select: jni::sys::jboolean,
) -> jni::sys::jboolean {
    let result = (|| -> anyhow::Result<()> {
        anyhow::ensure!(!ATLAS_CANCEL.load(Ordering::SeqCst), "Closed");
        let text: String = env.get_string(&input)?.into();
        anyhow::ensure!(text.len() <= 512, "Oversized bridge request");
        let command = if select != 0 {
            crate::policy::hash(&text)?;
            crate::atlas::Input::Select(text)
        } else {
            crate::atlas::Input::Blob(serde_json::from_str(&text)?)
        };
        ATLAS_QUEUE
            .lock()
            .map_err(|_| anyhow::anyhow!("Queue unavailable"))?
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Closed"))?
            .try_send(command)?;
        Ok(())
    })();
    if result.is_ok() { 1 } else { 0 }
}
#[unsafe(no_mangle)]
pub extern "system" fn Java_soy_napplet_fipsdemo_AtlasActivity_nativeRun(
    mut env: JNIEnv,
    activity: JObject,
    input: JString,
) {
    let outcome =
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| -> anyhow::Result<()> {
            let text: String = env.get_string(&input)?.into();
            anyhow::ensure!(text.len() <= 4096, "Settings too large");
            let settings: crate::atlas::Settings = serde_json::from_str(&text)?;
            let (tx, rx) = std::sync::mpsc::sync_channel(128);
            *ATLAS_QUEUE
                .lock()
                .map_err(|_| anyhow::anyhow!("Queue unavailable"))? = Some(tx);
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()?;
            runtime.block_on(crate::atlas::run(settings, rx, &ATLAS_CANCEL, |event| {
                if let Ok(text) = env.new_string(event.to_string()) {
                    if env
                        .call_method(
                            &activity,
                            "onAtlasEvent",
                            "(Ljava/lang/String;)V",
                            &[JValue::Object(&text)],
                        )
                        .is_err()
                    {
                        let _ = env.exception_clear();
                        ATLAS_CANCEL.store(true, Ordering::SeqCst);
                    }
                }
            }))
        }));
    if let Ok(mut q) = ATLAS_QUEUE.lock() {
        *q = None;
    }
    let message = match outcome {
        Ok(Ok(())) => "Native connection closed".into(),
        Ok(Err(e)) => format!("{e:#}"),
        Err(_) => "Native session stopped unexpectedly; reconnect".into(),
    };
    let stage = if ATLAS_CANCEL.load(Ordering::SeqCst) {
        "closed"
    } else {
        "error"
    };
    ATLAS_CANCEL.store(true, Ordering::SeqCst);
    ATLAS_RUNNING.store(false, Ordering::SeqCst);
    if let Ok(text) =
        env.new_string(serde_json::json!({"stage":stage,"message":message}).to_string())
    {
        let _ = env.call_method(
            &activity,
            "onAtlasEvent",
            "(Ljava/lang/String;)V",
            &[JValue::Object(&text)],
        );
    }
}
