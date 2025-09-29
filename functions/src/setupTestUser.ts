import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

const projectId = process.env.GCLOUD_PROJECT || "dietary-management-39e51";
process.env.GCLOUD_PROJECT = projectId;
initializeApp({ projectId });

const db = getFirestore();
const firestoreEmulatorHost = process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
const useEmulator = (process.env.USE_FIRESTORE_EMULATOR ?? "true") !== "false";

if (!process.env.FIRESTORE_EMULATOR_HOST && useEmulator) {
  process.env.FIRESTORE_EMULATOR_HOST = firestoreEmulatorHost;
}

if (useEmulator) {
  db.settings({
    host: firestoreEmulatorHost,
    ssl: false,
  });
  console.log(`[emulator] Using Firestore emulator at ${firestoreEmulatorHost}`);
}

async function createTestUser() {
  await db.collection("users").doc("test-user1").set({
    notificationMode: "fcm",
    fcmToken: "dummy_token1",
    updatedAt: FieldValue.serverTimestamp(),
  });
  console.log("[ok] Test user created");
}

createTestUser().catch((error) => {
  console.error("[error] Failed to create test user", error);
  process.exitCode = 1;
});
