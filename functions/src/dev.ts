import { sendMealReminder } from "./index";

if (!process.env.FUNCTIONS_EMULATOR) {
  process.env.FUNCTIONS_EMULATOR = "true";
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  process.env.FIRESTORE_EMULATOR_HOST = "localhost:8080";
}

// コマンドライン引数からスロットを選べるようにする（任意）
const slotArg = process.argv[2] ?? "lunch";
const allowedSlots = ["breakfast", "lunch", "dinner"] as const;

if (!allowedSlots.includes(slotArg as any)) {
  console.error("Invalid slot. Use 'breakfast', 'lunch', or 'dinner'.");
  process.exit(1);
}

(async () => {
  try {
    await sendMealReminder(slotArg as typeof allowedSlots[number]);
    console.log(`✅ ${slotArg} reminder executed successfully.`);
  } catch (error) {
    console.error("❌ Error executing reminder:", error);
    process.exit(1);
  }
})();
