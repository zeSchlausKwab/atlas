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
