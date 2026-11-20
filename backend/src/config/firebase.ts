import { App, applicationDefault, cert, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { Auth, getAuth } from 'firebase-admin/auth';
import { Firestore, getFirestore } from 'firebase-admin/firestore';
import { Messaging, getMessaging } from 'firebase-admin/messaging';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

let firebaseApp: App | null = null;
let firestoreInstance: Firestore | null = null;
let authInstance: Auth | null = null;
let messagingInstance: Messaging | null = null;
let initializationError: string | null = null;

export function initializeFirebaseAdmin(): {
  initialized: boolean;
  error: string | null;
} {
  if (firebaseApp) {
    return { initialized: true, error: null };
  }

  try {
    if (getApps().length > 0) {
      firebaseApp = getApp();
    } else {
      const projectId = env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || undefined;

      if (env.FIREBASE_SERVICE_ACCOUNT_JSON.trim().length > 0) {
        const serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
        firebaseApp = initializeApp({
          credential: cert(serviceAccount),
          projectId: projectId || serviceAccount.project_id,
        });
      } else {
        // Uses Google Cloud Run Application Default Credentials (ADC) or GOOGLE_APPLICATION_CREDENTIALS
        firebaseApp = initializeApp({
          credential: applicationDefault(),
          ...(projectId ? { projectId } : {}),
        });
      }
    }

    firestoreInstance =
      env.FIRESTORE_DATABASE_ID && env.FIRESTORE_DATABASE_ID !== '(default)'
        ? getFirestore(firebaseApp, env.FIRESTORE_DATABASE_ID)
        : getFirestore(firebaseApp);

    firestoreInstance.settings({ ignoreUndefinedProperties: true });
    authInstance = getAuth(firebaseApp);
    messagingInstance = getMessaging(firebaseApp);
    initializationError = null;

    logger.info('Firebase Admin SDK initialized', {
      projectId: env.FIREBASE_PROJECT_ID || env.GOOGLE_CLOUD_PROJECT || 'auto-adc',
      databaseId: env.FIRESTORE_DATABASE_ID,
    });

    return { initialized: true, error: null };
  } catch (err) {
    initializationError = err instanceof Error ? err.message : String(err);
    logger.warn('Firebase Admin SDK could not initialize at startup; Firestore/Auth operations require valid credentials', {
      error: initializationError,
    });
    return { initialized: false, error: initializationError };
  }
}

export function getFirebaseStatus(): { initialized: boolean; error: string | null } {
  return {
    initialized: Boolean(firebaseApp && firestoreInstance),
    error: initializationError,
  };
}

export function getDb(): Firestore {
  if (!firestoreInstance) {
    const res = initializeFirebaseAdmin();
    if (!res.initialized || !firestoreInstance) {
      throw new Error(`Firestore is not available: ${res.error || 'Firebase Admin not initialized'}`);
    }
  }
  return firestoreInstance;
}

export function getFirebaseAuth(): Auth {
  if (!authInstance) {
    const res = initializeFirebaseAdmin();
    if (!res.initialized || !authInstance) {
      throw new Error(`Firebase Auth is not available: ${res.error || 'Firebase Admin not initialized'}`);
    }
  }
  return authInstance;
}

export function getFcm(): Messaging {
  if (!messagingInstance) {
    const res = initializeFirebaseAdmin();
    if (!res.initialized || !messagingInstance) {
      throw new Error(`Firebase Cloud Messaging is not available: ${res.error || 'Firebase Admin not initialized'}`);
    }
  }
  return messagingInstance;
}
