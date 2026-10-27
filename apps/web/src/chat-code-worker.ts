import { runCode } from "../../../packages/chat/src/sandbox";
self.onmessage = async ({ data }) => {
  try {
    postMessage({ value: await runCode(data.code, data.data) });
  } catch (e) {
    postMessage({ error: e instanceof Error ? e.message : String(e) });
  }
};
