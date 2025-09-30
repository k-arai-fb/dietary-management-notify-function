// スケジュールされたFCM配信のためのCloud Functionsエントリポイント
import {existsSync, readFileSync} from "node:fs";
import {resolve} from "node:path";

import {onSchedule} from "firebase-functions/v2/scheduler";
import * as logger from "firebase-functions/logger";
import {applicationDefault, cert, initializeApp, type ServiceAccount} from "firebase-admin/app";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getMessaging} from "firebase-admin/messaging";
import type {MulticastMessage} from "firebase-admin/messaging";


// クライアント実装と共有する食事リマインダーのスロット定義
type MealSlot = "breakfast" | "lunch" | "dinner";

// 各リマインダーのスケジュールと表示に必要なメタデータ
interface ReminderConfig {
  cron: string;
  title: string;
  body: string;
}

// トークンバッチを加える前のFCMメッセージ共通部分
type BaseMulticastMessage = Omit<MulticastMessage, "tokens">;


// Firestore Emulator 利用時は明示的にプロジェクトIDと接続先を指定
const defaultServiceAccountPath = resolve(
  __dirname,
  "..",
  "dietary-management-39e51-firebase-adminsdk-fbsvc-f315ff3965.json",
);

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS && existsSync(defaultServiceAccountPath)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = defaultServiceAccountPath;
}

const projectId = process.env.GCLOUD_PROJECT || "dietary-management-39e51";
process.env.GCLOUD_PROJECT = projectId;


// FirestoreとMessagingの利用のためにAdmin SDKを初期化
const serviceAccount: ServiceAccount | undefined = existsSync(defaultServiceAccountPath)
  ? (JSON.parse(readFileSync(defaultServiceAccountPath, "utf8")) as ServiceAccount)
  : undefined;

initializeApp({
  projectId,
  credential: serviceAccount ? cert(serviceAccount) : applicationDefault(),
});
// スケジュールジョブで使い回すサービスハンドル
const db = getFirestore();
const messaging = getMessaging();


const resolveEmulatorHost = (): string => process.env.FIRESTORE_EMULATOR_HOST || "localhost:8080";
let appliedFirestoreHost: string | null = null;

const ensureFirestoreTarget = (): void => {
  const shouldUseEmulator = process.env.FUNCTIONS_EMULATOR === "true" || !!process.env.FIRESTORE_EMULATOR_HOST;
  if (!shouldUseEmulator) {
    return;
  }

  const host = resolveEmulatorHost();
  if (appliedFirestoreHost === host) {
    return;
  }

  db.settings({
    host,
    ssl: false,
  });
  process.env.FIRESTORE_EMULATOR_HOST = host;
  appliedFirestoreHost = host;
};

// iOSのローカル通知仕様に合わせたプッシュペイロード用定数
const TIME_ZONE = "Asia/Tokyo";
const THREAD_ID = "meal-reminder-thread";
const CATEGORY = "TASK_CATEGORY";
const DEEPLINK_BASE = "dietary://meal";
const CHUNK_SIZE = 500;
// Cloud Functionsエミュレータ上で動作しているかどうかの判定
const isFunctionsEmulator = (): boolean => process.env.FUNCTIONS_EMULATOR === "true";
// ローカルでも実機送信したい要件に合わせスキップ制御を環境変数に委譲
const shouldSkipFcm = (): boolean => process.env.SKIP_FCM_SEND === "true";

// 各リマインダーの配信時刻と文言
const REMINDER_CONFIG: Record<MealSlot, ReminderConfig> = {
  breakfast: {
    cron: "0 7 * * *",
    title: "朝食の記録",
    body: "朝の食事内容を入力してください",
  },
  lunch: {
    cron: "0 13 * * *",
    title: "昼食の記録",
    body: "昼の食事内容を入力してください",
  },
  dinner: {
    cron: "0 19 * * *",
    title: "夕食の記録",
    body: "夜の食事内容を入力してください",
  },
};

// 保存されたトークンが無効であることを示すエラーコード群
const TOKEN_ERROR_CODES = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);

// FCM受信者となるFirestoreレコードの情報
interface Recipient {
  token: string;
  userId: string;
}

// リマインダーメタデータをFCMとAPNsのペイロードに変換
const buildMessage = (slot: MealSlot): BaseMulticastMessage => {
  const {title, body} = REMINDER_CONFIG[slot];
  const deeplink = `${DEEPLINK_BASE}/${slot}`;

  return {
    notification: {title, body},
    data: {
      deeplink,
      mealSlot: slot,
      category: CATEGORY,
      threadId: THREAD_ID,
    },
    apns: {
      headers: {
        "apns-priority": "10",
        "apns-push-type": "alert",
      },
      payload: {
        aps: {
          alert: {title, body},
          sound: "default",
          category: CATEGORY,
          "thread-id": THREAD_ID,
          "interruption-level": "time-sensitive",
          "relevance-score": 0.9,
        },
        deeplink,
        mealSlot: slot,
      },
    },
  };
};

// FCM制限に収まるよう受信者リストをバッチ化
const chunkRecipients = (recipients: Recipient[]): Recipient[][] => {
  const chunks: Recipient[][] = [];
  for (let i = 0; i < recipients.length; i += CHUNK_SIZE) {
    chunks.push(recipients.slice(i, i + CHUNK_SIZE));
  }
  return chunks;
};

// 各cronトリガーと開発用スクリプトが利用する送信処理の本体
export const sendMealReminder = async (slot: MealSlot): Promise<void> => {
  ensureFirestoreTarget();
  // cron実行ログの出力
  const config = REMINDER_CONFIG[slot];
  logger.info("Meal reminder triggered", {slot, schedule: config.cron});

  // FCM通知を選択したユーザーを取得
  const snapshot = await db
    .collection("users")
    .where("notificationMode", "==", "fcm")
    .get();


  // ユーザーIDと紐づくトークンのリストを整形
  const recipients: Recipient[] = snapshot.docs
    .map((doc) => {
      const data = doc.data();
      const token = typeof data.fcmToken === "string" ? data.fcmToken.trim() : "";
      if (!token) return undefined;
      return {token, userId: doc.id};
    })
    .filter((entry): entry is Recipient => Boolean(entry));

  // 通知対象者がいなければ処理終了
  if (recipients.length === 0) {
    logger.info("No FCM recipients to notify", {slot});
    return;
  }

  // 当該スロットの全バッチで共有するペイロードを準備
  const baseMessage = buildMessage(slot);
  const invalidUserIds: string[] = [];
  let successCount = 0;

  for (const batch of chunkRecipients(recipients)) {
    // 最大500件ずつ送信
    const tokens = batch.map((recipient) => recipient.token);
    if (shouldSkipFcm()) {
      logger.info("環境設定によりFCM送信をスキップ", {slot, tokens, IS_FUNCTIONS_EMULATOR: isFunctionsEmulator()});
      successCount += tokens.length;
      continue;
    }

    try {
      const response = await messaging.sendEachForMulticast({
        ...baseMessage,
        tokens,
      });

      // 無効トークンを検出するため各結果を確認
      response.responses.forEach((res, index) => {
        if (res.success) {
          successCount += 1;
          return;
        }

        const userId = batch[index]?.userId;
        const code = res.error?.code;
        if (code && TOKEN_ERROR_CODES.has(code) && userId) {
          invalidUserIds.push(userId);
        }
        logger.warn("Failed to deliver notification", {
          slot,
          userId,
          code,
          message: res.error?.message,
        });
      });
    } catch (error) {
      // バッチ送信時の想定外エラーを記録
      logger.error("Failed to send multicast batch", {slot, error});
    }
  }

  // 監視用に集計結果を記録
  logger.info("Finished sending meal reminders", {
    slot,
    successCount,
    attempted: recipients.length,
    invalidUserCount: invalidUserIds.length,
  });

  // 今後の実行で無効トークンを除外するため削除
  if (invalidUserIds.length > 0) {
    await Promise.all(
      invalidUserIds.map(async (userId) => {
        try {
          await db
            .collection("users")
            .doc(userId)
            .update({
              fcmToken: FieldValue.delete(),
              updatedAt: FieldValue.serverTimestamp(),
            });
        } catch (error) {
          // クリーンアップに失敗した場合は後で再試行できるよう残す
          logger.warn("Failed to clean up invalid token", {slot, userId, error});
        }
      }),
    );
  }
};

// 日本時間07時に実行
export const sendBreakfastReminder = onSchedule(
  {
    schedule: REMINDER_CONFIG.breakfast.cron,
    timeZone: TIME_ZONE,
  },
  async () => sendMealReminder("breakfast"),
);

// 日本時間13時に実行
export const sendLunchReminder = onSchedule(
  {
    schedule: REMINDER_CONFIG.lunch.cron,
    timeZone: TIME_ZONE,
  },
  async () => sendMealReminder("lunch"),
);

// 日本時間19時に実行
export const sendDinnerReminder = onSchedule(
  {
    schedule: REMINDER_CONFIG.dinner.cron,
    timeZone: TIME_ZONE,
  },
  async () => sendMealReminder("dinner"),
);
