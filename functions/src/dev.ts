import {spawnSync} from "node:child_process";
import {existsSync, statSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

type Slot = "breakfast" | "lunch" | "dinner";

const FUNCTIONS_DIR = resolve(__dirname, "..");
const SRC_INDEX = resolve(FUNCTIONS_DIR, "src", "index.ts");
const BUILD_INDEX = resolve(FUNCTIONS_DIR, "lib", "index.js");

const ensureEmulatorEnv = () => {
  if (!process.env.FUNCTIONS_EMULATOR) {
    process.env.FUNCTIONS_EMULATOR = "true";
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
  }
  if (!process.env.SKIP_FCM_SEND) {
    process.env.SKIP_FCM_SEND = "true";
  }
};

const needsBuild = () => {
  if (!existsSync(BUILD_INDEX)) {
    return true;
  }

  try {
    const srcStat = statSync(SRC_INDEX);
    const buildStat = statSync(BUILD_INDEX);
    return buildStat.mtimeMs < srcStat.mtimeMs;
  } catch {
    return true;
  }
};

const ensureBuiltBundle = () => {
  if (!needsBuild()) {
    return;
  }

  const result = spawnSync("npm", ["run", "build"], {
    cwd: FUNCTIONS_DIR,
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error("Failed to build functions project before executing reminder");
  }
};

const parseSlotArg = (): Slot => {
  const slotArg = process.argv[2] ?? "lunch";
  const allowedSlots: Slot[] = ["breakfast", "lunch", "dinner"];
  if (!allowedSlots.includes(slotArg as Slot)) {
    console.error("Invalid slot. Use 'breakfast', 'lunch', or 'dinner'.");
    process.exit(1);
  }
  return slotArg as Slot;
};

(async () => {
  try {
    ensureEmulatorEnv();
    ensureBuiltBundle();

    const moduleUrl = pathToFileURL(BUILD_INDEX).href;
    const {sendMealReminder} = (await import(moduleUrl)) as {
      sendMealReminder: (slot: Slot) => Promise<void>;
    };

    const slot = parseSlotArg();
    await sendMealReminder(slot);
    console.log(`✅ ${slot} reminder executed successfully.`);
  } catch (error) {
    console.error("❌ Error executing reminder:", error);
    process.exit(1);
  }
})();
