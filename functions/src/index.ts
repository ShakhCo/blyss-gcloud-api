import {setGlobalOptions} from "firebase-functions";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {defineSecret, defineString} from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import {getFirestore} from "firebase-admin/firestore";
import {initializeApp} from "firebase-admin/app";

const telegramBotToken = defineSecret("TELEGRAM_BOT_TOKEN");
const telegramChatId = defineSecret("TELEGRAM_CHAT_ID");
const databaseId = defineString("DATABASE_ID");

initializeApp();

const generateOtpCode = (): string => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

setGlobalOptions({maxInstances: 10});

export const onUserCreated = onDocumentCreated(
  {
    document: "users/{userId}",
    database: databaseId,
    region: "europe-north1",
    secrets: [telegramBotToken, telegramChatId],
  },
  async (event) => {
    const snapshot = event.data;
    if (!snapshot) {
      logger.error("No data in event");
      return;
    }

    const userId = event.params.userId;
    const userData = snapshot.data();

    logger.info("New user created", {
      userId,
      firstName: userData.first_name,
      phoneNumber: userData.phone_number,
    });

    // Send Telegram notification
    const message = "🆕 New user registered!\n\n" +
      `👤 Name: ${userData.first_name} ${userData.last_name || ""}\n` +
      `📱 Phone: ${userData.phone_number}\n` +
      `🆔 Telegram ID: ${userData.telegram_id}\n` +
      `🔑 User ID: ${userId}`;

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${telegramBotToken.value()}/sendMessage`,
        {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            chat_id: telegramChatId.value(),
            text: message,
            parse_mode: "HTML",
          }),
        }
      );

      if (!response.ok) {
        logger.error("Failed to send Telegram message", await response.text());
      } else {
        logger.info("Telegram notification sent successfully");
      }
    } catch (error) {
      logger.error("Error sending Telegram message", error);
    }

    // Create OTP for the new user
    try {
      const db = getFirestore(databaseId.value());
      const otpCode = generateOtpCode();

      await db.collection("otps").add({
        user_id: userId,
        otp_code: otpCode,
        date_created: new Date(),
        used: false,
      });

      logger.info("OTP created for user", {userId, otpCode});
    } catch (error) {
      logger.error("Error creating OTP", error);
    }
  }
);
