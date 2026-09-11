import { state } from "./state.mjs";

export async function readFile(path, encoding) {
  state.readFileCalls.push({ path, encoding });
  if (state.credentialsText !== undefined) return state.credentialsText;
  throw state.credentialsError;
}
