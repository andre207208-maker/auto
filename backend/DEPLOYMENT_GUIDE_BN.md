# AUTOBLOGGER AI Backend — মোবাইল ফোন এবং GitHub ব্যবহার করে Google Cloud Run-এ ডিপ্লয়মেন্ট গাইড (বাংলায়)

এই গাইডে দেখানো হয়েছে কীভাবে **শুধুমাত্র একটি অ্যান্ড্রয়েড মোবাইল ফোন (Chrome ব্রাউজার)** এবং **GitHub** ব্যবহার করে কোনো পিসি/ল্যাপটপ ছাড়াই `/backend` সার্ভারটি **Google Cloud Run**-এ ডিপ্লয় করবেন এবং সেই লাইভ URL আপনার **AUTOBLOGGER AI Android অ্যাপের Setup Wizard**-এ যুক্ত করবেন।

---

## ধাপ ১: GitHub রিপোজিটরি তৈরি ও কোড আপলোড (মোবাইল থেকে)

1. আপনার ফোনের ব্রাউজারে [github.com](https://github.com) খুলে লগইন করুন।
2. ডানদিকের **`+` আইকনে** ট্যাপ করে **New repository** সিলেক্ট করুন।
3. Repository-র নাম দিন (যেমন: `autoblogger-ai-backend`), **Private** সিলেক্ট করুন এবং **Create repository** চাপুন।
4. আপনার প্রজেক্টের `/backend` ফোল্ডারের সব ফাইল (`Dockerfile`, `package.json`, `tsconfig.json`, `.dockerignore`, `.env.example`, এবং সম্পূর্ণ `src/` ফোল্ডার) এই রিপোজিটরির রুট অথবা `/backend` ফোল্ডারে আপলোড/পুশ করুন।
   - **সতর্কতা:** কখনোই `.env` ফাইল বা আসল API Key / Service Account JSON ফাইল GitHub-এ আপলোড করবেন না। `.env.example` শুধু রেফারেন্সের জন্য।

---

## ধাপ ২: Google Cloud প্রজেক্ট ও প্রয়োজনীয় API চালু করা

1. ফোনে Chrome ব্রাউজার খুলে **Desktop site (ডেস্কটপ সাইট)** অন করুন এবং [console.cloud.google.com](https://console.cloud.google.com) ওপেন করুন।
2. উপরের প্রজেক্ট সিলেক্টর থেকে আপনার প্রজেক্ট বেছে নিন (অথবা নতুন প্রজেক্ট তৈরি করুন, যেমন `autoblogger-ai-prod`)।
   - *গুরুত্বপূর্ণ:* Cloud Run ও Cloud Scheduler ব্যবহারের জন্য প্রজেক্টে একটি **Billing Account** যুক্ত থাকতে হবে (Google Cloud-এর Free Tier কোটা থাকলেও কার্ড/বিলিং অ্যাক্টিভেশন লাগে)।
3. বামদিকের মেনু থেকে **APIs & Services > Library**-তে যান এবং নিচের **প্রতিটি API Enable করুন**:
   - **Cloud Run Admin API** (`run.googleapis.com`)
   - **Cloud Build API** (`cloudbuild.googleapis.com`)
   - **Artifact Registry API** (`artifactregistry.googleapis.com`)
   - **Cloud Firestore API** (`firestore.googleapis.com`)
   - **Cloud Scheduler API** (`cloudscheduler.googleapis.com`)
   - **Cloud Tasks API** (`cloudtasks.googleapis.com`)
   - **Firebase Cloud Messaging API** (`fcm.googleapis.com`)
   - **Blogger API v3** (`blogger.googleapis.com`)
   - **Google Search Console API** (`searchconsole.googleapis.com`)
   - **Google Analytics Data API** (`analyticsdata.googleapis.com`)
   - **Secret Manager API** (`secretmanager.googleapis.com`) — *নিরাপদভাবে কী রাখার জন্য*

---

## ধাপ ৩: Firebase ও Firestore কনফিগারেশন

1. ব্রাউজারে [console.firebase.google.com](https://console.firebase.google.com) ওপেন করুন।
2. **Add project** ক্লিক করে ধাপ ২-এ তৈরি করা একই Google Cloud প্রজেক্টটি সিলেক্ট করুন (এতে Firebase ও Cloud Run একই প্রজেক্টে থাকবে এবং আলাদা JSON Key ছাড়াই ADC দিয়ে কাজ করবে)।
3. বাম মেনু থেকে **Build > Firestore Database**-এ যান:
   - **Create database** চাপুন।
   - লোকেশন হিসেবে `asia-south1` (Mumbai) অথবা আপনার নিকটবর্তী রিজন বেছে নিন।
   - **Start in production mode** সিলেক্ট করুন (কারণ ব্যাকএন্ড Firebase Admin SDK ব্যবহার করে)।
4. বাম মেনু থেকে **Build > Authentication > Get started** চালু করুন এবং যেই Sign-in পদ্ধতি আপনার অ্যান্ড্রয়েড অ্যাপ ব্যবহার করে (যেমন **Google** বা **Email/Password**) সেটি Enable করুন।
5. **Cloud Messaging** (FCM) স্বয়ংক্রিয়ভাবে প্রজেক্টে সক্রিয় থাকে। আপনার Android অ্যাপের `google-services.json` যেন এই একই Firebase প্রজেক্ট থেকে ডাউনলোড করা হয়।

---

## ধাপ ৪: Service Account Permission (IAM) সেটআপ

Cloud Run যেন Firestore, Cloud Tasks এবং FCM ব্যবহার করতে পারে, তার জন্য:
1. Google Cloud Console-এ **IAM & Admin > IAM**-এ যান।
2. আপনার Cloud Run সার্ভিস অ্যাকাউন্টটি খুঁজুন (সাধারণত `<PROJECT_NUMBER>-compute@developer.gserviceaccount.com` অথবা একটি কাস্টম সার্ভিস অ্যাকাউন্ট)।
3. এডিট (পেন্সিল) আইকনে ট্যাপ করে নিচের Role-গুলো যুক্ত করুন:
   - **Cloud Datastore User** (`roles/datastore.user`) — Firestore read/write-এর জন্য
   - **Firebase Cloud Messaging Admin** (`roles/firebasecloudmessaging.admin`) — Push notification পাঠানোর জন্য
   - **Cloud Tasks Enqueuer** (`roles/cloudtasks.enqueuer`) — টাস্ক কিউ করার জন্য
   - **Service Account Token Creator** (`roles/iam.serviceAccountTokenCreator`) — Cloud Tasks OIDC টোকেনের জন্য

---

## ধাপ ৫: এনভায়রনমেন্ট ভেরিয়েবল (Environment Variables) প্রস্তুত করা

Cloud Run ডিপ্লয় করার সময় নিচের ভেরিয়েবলগুলো দিতে হবে (নিজে থেকে শক্তিশালী র‍্যান্ডম পাসওয়ার্ড তৈরি করে নিন):

| ভেরিয়েবল | উদাহরণ / ব্যাখ্যা |
| :--- | :--- |
| `NODE_ENV` | `production` |
| `SERVICE_NAME` | `autoblogger-ai-backend` |
| `BACKEND_API_SECRET` | কমপক্ষে ৩২ অক্ষরের গোপন কী (Android অ্যাপের `X-API-Key`-এর সাথে মিলতে হবে) |
| `SCHEDULER_SHARED_SECRET` | Cloud Scheduler ও Cloud Tasks-এর জন্য আরেকটি গোপন কী |
| `ALLOW_API_KEY_AUTH` | `true` |
| `GOOGLE_CLOUD_PROJECT` | আপনার GCP Project ID |
| `FIREBASE_PROJECT_ID` | আপনার Firebase Project ID (একই ID) |
| `FIRESTORE_DATABASE_ID` | `(default)` |
| `AI_PROVIDER_ORDER` | `gemini,openrouter,apinex,custom` |
| `GEMINI_API_KEY` | আপনার Google Gemini API Key |
| `OPENROUTER_API_KEY` | *(ঐচ্ছিক)* OpenRouter API Key |
| `APINEX_API_KEY` | *(ঐচ্ছিক)* API-NEX Key |
| `CUSTOM_AI_API_KEY` / `CUSTOM_AI_BASE_URL` / `CUSTOM_AI_MODEL` | *(ঐচ্ছিক)* কাস্টম OpenAI-compatible API |
| `GOOGLE_OAUTH_CLIENT_ID` | Google Cloud Credentials থেকে OAuth Client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google Cloud Credentials থেকে OAuth Client Secret |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Blogger, Search Console ও GA4 স্কোপসহ Refresh Token |
| `DEFAULT_BLOGGER_BLOG_ID` | আপনার Blogger ব্লগের সংখ্যাসূচক ID |
| `GSC_SITE_URL` | যেমন `https://yourblog.blogspot.com/` |
| `GA4_PROPERTY_ID` | আপনার GA4 Property ID (শুধু সংখ্যা) |
| `ADSTERRA_API_KEY` | *(ঐচ্ছিক)* Adsterra Publisher API Key |

---

## ধাপ ৬: মোবাইল ব্রাউজার থেকে GitHub-এর মাধ্যমে Cloud Run-এ ডিপ্লয় করা

1. Google Cloud Console (Desktop mode চালু রেখে) থেকে **Cloud Run**-এ যান।
2. উপরের **Deploy Container > Service** বাটনে ট্যাপ করুন।
3. **"Continuously deploy from a repository (Source or Function)"** অপশনটি সিলেক্ট করুন এবং **Set up with Cloud Build** চাপুন।
4. **Source Repository**:
   - **Repository Provider:** `GitHub` সিলেক্ট করে আপনার GitHub অ্যাকাউন্ট অথোরাইজ করুন।
   - ধাপ ১-এ তৈরি করা `autoblogger-ai-backend` রিপোজিটরিটি সিলেক্ট করুন।
   - **Next** চাপুন।
5. **Build Configuration**:
   - **Branch:** `^main$` (অথবা আপনার ডিফল্ট ব্রাঞ্চ)।
   - **Build Type:** **Dockerfile** সিলেক্ট করুন।
   - **Source location:** রিপোজিটরির রুটে রাখলে `/Dockerfile`, আর `/backend` সাব-ফোল্ডারে রাখলে `/backend/Dockerfile` লিখুন (এবং Build context হবে `/backend`)।
   - **Save** চাপুন।
6. **Service settings**:
   - **Service name:** `autoblogger-ai-backend`
   - **Region:** `asia-south1` (Mumbai) বা `asia-east1`
   - **Authentication:** **Allow unauthenticated invocations** সিলেক্ট করুন। *(ভয় পাবেন না — আমাদের কোডের ভেতরে Firebase ID Token ও `X-API-Key` মিডলওয়্যার সব `/api/v1/*` রুট সুরক্ষিত রাখে, শুধু `/health` অ্যান্ড্রয়েড Setup Wizard-এর জন্য খোলা থাকে)।*
   - **Container, Networking, Security** সেকশন এক্সপ্যান্ড করুন:
     - **Container port:** `8080`
     - **Memory:** `512 MiB` (বা `1 GiB`)
     - **Variables & Secrets** ট্যাবে গিয়ে ধাপ ৫-এর সব Environment Variables যোগ করুন।
7. একদম নিচে গিয়ে **Create** বাটনে ট্যাপ করুন।
8. Cloud Build অটোমেটিক আপনার Docker ইমেজ তৈরি করবে এবং ২–৪ মিনিটের মধ্যে Cloud Run-এ লাইভ করে দেবে।

---

## ধাপ ৭: Cloud Run Service URL সংগ্রহ করা ও যাচাই করা

1. ডিপ্লয়মেন্ট সফল হলে Cloud Run সার্ভিসের ড্যাশবোর্ডের একদম উপরে সবুজ টিক চিহ্নের পাশে আপনার HTTPS URL দেখতে পাবেন, যেমন:
   `https://autoblogger-ai-backend-xxxxxxxxxx-el.a.run.app`
2. URL-টি কপি করুন এবং মোবাইলের ব্রাউজারে নতুন ট্যাবে ওপেন করুন:
   `https://autoblogger-ai-backend-xxxxxxxxxx-el.a.run.app/health`
3. ব্রাউজারে যদি নিচের মতো JSON রেসপন্স আসে, তবে বুঝবেন ব্যাকএন্ড ১০০% সঠিকভাবে চলছে:
   ```json
   {
     "status": "ok",
     "service": "autoblogger-ai-backend",
     "version": "1.0.0",
     "firebaseConnected": true,
     "agentStatus": "running"
   }
   ```
4. *(গুরুত্বপূর্ণ)* এবার Cloud Run সার্ভিসের **Edit & deploy new revision**-এ গিয়ে `CLOUD_RUN_SERVICE_URL` ভেরিয়েবলে এই আসল URL-টি সেট করে সেভ করুন (যদি Cloud Tasks ব্যবহার করেন)।

---

## ধাপ ৮: Cloud Tasks এবং Cloud Scheduler সেটআপ

### ক) Cloud Tasks Queue তৈরি (ঐচ্ছিক কিন্তু প্রস্তাবিত):
1. Google Cloud Console-এ **Cloud Tasks**-এ যান > **Create Queue**।
2. নাম দিন `autoblogger-tasks`, রিজন দিন `asia-south1`।
3. Cloud Run-এর এনভায়রনমেন্ট ভেরিয়েবলে `CLOUD_TASKS_ENABLED=true` ও `CLOUD_TASKS_QUEUE=autoblogger-tasks` সেট করুন।

### খ) Cloud Scheduler জব তৈরি:
Google Cloud Console থেকে **Cloud Scheduler > Create Job**-এ গিয়ে নিচের ৪টি জব তৈরি করুন (Region: `asia-south1`):

1. **Autonomous Publishing Tick (প্রতি ১ ঘণ্টায়):**
   - Frequency: `0 * * * *`
   - Target type: **HTTP**
   - URL: `https://<YOUR-CLOUD-RUN-URL>/api/v1/scheduler/tick`
   - HTTP method: `POST`
   - Headers: `Content-Type: application/json`, `X-Scheduler-Secret: <আপনার SCHEDULER_SHARED_SECRET>`
   - Body: `{}`

2. **Task Queue Retry Processor (প্রতি ৫ মিনিটে):**
   - Frequency: `*/5 * * * *`
   - URL: `https://<YOUR-CLOUD-RUN-URL>/api/v1/tasks/process-retries`
   - HTTP method: `POST`
   - Headers: `Content-Type: application/json`, `X-Scheduler-Secret: <আপনার SCHEDULER_SHARED_SECRET>`
   - Body: `{"limit": 15}`

3. **Daily Analytics Sync (প্রতিদিন রাত ১১:৫০-এ):**
   - Frequency: `50 23 * * *`
   - Timezone: `Asia/Dhaka`
   - URL: `https://<YOUR-CLOUD-RUN-URL>/api/v1/workers/analytics/daily`
   - HTTP method: `POST`
   - Headers: `Content-Type: application/json`, `X-Scheduler-Secret: <আপনার SCHEDULER_SHARED_SECRET>`
   - Body: `{}`

4. **Weekly Analytics Sync (প্রতি রবিবার রাত ১১:৫৫-এ):**
   - Frequency: `55 23 * * 0`
   - Timezone: `Asia/Dhaka`
   - URL: `https://<YOUR-CLOUD-RUN-URL>/api/v1/workers/analytics/weekly`
   - HTTP method: `POST`
   - Headers: `Content-Type: application/json`, `X-Scheduler-Secret: <আপনার SCHEDULER_SHARED_SECRET>`
   - Body: `{}`

---

## ধাপ ৯: Android অ্যাপ্লিকেশনের Setup Wizard-এ URL যুক্ত করা

1. আপনার ফোনে **AUTOBLOGGER AI** Android অ্যাপটি ওপেন করুন।
2. **Setup Wizard**-এ প্রবেশ করুন।
3. **Cloud Run Backend URL** ঘরে ধাপ ৭-এ পাওয়া আসল HTTPS URL-টি পেস্ট করুন (যেমন: `https://autoblogger-ai-backend-xxxxxxxxxx-el.a.run.app`, শেষে `/` ছাড়াই)।
4. যদি অ্যাপে Backend API Secret চায়, তবে `BACKEND_API_SECRET` দিন (অথবা Firebase Google Sign-In ব্যবহার করলে আইডি টোকেন অটোমেটিক যাবে)।
5. **Verify Backend** বাটনে ট্যাপ করুন।
6. অ্যাপটি সরাসরি `<YOUR-CLOUD-RUN-URL>/health` ঠিকানায় `GET` রিকোয়েস্ট পাঠাবে। সার্ভার থেকে `HTTP 200` এবং `"status": "ok"` রেসপন্স পেলেই কেবল Setup Wizard-এ **"Verified / Connected"** দেখাবে।
7. এরপর আপনার Android অ্যাপ থেকেই AI এজেন্ট Pause/Resume/Emergency Stop, Blogger পোস্ট পাবলিশ, Adsterra অ্যাড ম্যানেজমেন্ট ও Analytics দেখতে পারবেন।
