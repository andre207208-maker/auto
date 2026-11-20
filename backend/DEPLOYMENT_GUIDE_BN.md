# AUTOBLOGGER AI Backend — Cloudflare Workers Dashboard-এর মাধ্যমে ডিপ্লয়মেন্ট গাইড (বাংলায়)

এই গাইডে দেখানো হয়েছে কীভাবে **Cloud Run (যাতে Billing লাগে)** এবং **Paid Cloudflare Queues/R2** বাদ দিয়ে **সম্পূর্ণ Cloudflare Free Plan (Workers + D1 + Cron Triggers)** ব্যবহার করে কোনো ক্রেডিট কার্ড বা পেইড প্ল্যান ছাড়াই **AUTOBLOGGER AI** ব্যাকএন্ড ডিপ্লয় করবেন এবং আপনার **Android অ্যাপের Setup Wizard**-এ সংযুক্ত করবেন।

> **গুরুত্বপূর্ণ:** আপনার শুধু একটি **Cloudflare D1 Database (`autoblogger-db`)** লাগবে। কোনো Paid Queues বা R2 Bucket প্রয়োজন নেই।

---

## ধাপ ১: Cloudflare অ্যাকাউন্ট ও D1 ডাটাবেস তৈরি (Dashboard থেকে)

1. আপনার মোবাইল বা কম্পিউটারের ব্রাউজারে [dash.cloudflare.com](https://dash.cloudflare.com) খুলে লগইন করুন (মোবাইলে Chrome-এ **Desktop site** চালু করে নিন)।
2. বামদিকের মেনু থেকে **Storage & Databases > D1 SQL Database**-এ যান।
3. **Create Database** বাটনে ক্লিক করুন:
   - **Name:** `autoblogger-db`
   - **Location:** আপনার নিকটবর্তী অঞ্চল (যেমন Asia-Pacific / Automatic) সিলেক্ট করে **Create** চাপুন।
4. তৈরি হওয়ার পর ড্যাশবোর্ড থেকে আপনার **Database ID** (UUID ফরম্যাট) কপি করে `backend/wrangler.jsonc`-এর `d1_databases[0].database_id`-তে বসান।

---

## ধাপ ২: D1 ডাটাবেসে টেবিল তৈরি (Migrations চালানো)

1. GitHub Actions স্বয়ংক্রিয়ভাবে নিচের কমান্ডটি চালিয়ে মাইগ্রেশন প্রয়োগ করে:
   ```bash
   npx wrangler d1 migrations apply autoblogger-db --remote
   ```
2. এতে `0001_initial_schema.sql`, `0002_settings_and_ratelimits.sql`, এবং `0003_d1_job_queue_and_media.sql` প্রয়োগ হয়ে D1 জব কিউ, লকিং, মিডিয়া ব্যাকআপ এবং সব টেবিল তৈরি হয়ে যাবে।

---

## ধাপ ৩: Free Plan জব কিউ ও মিডিয়া স্টোরেজ (অতিরিক্ত কোনো সার্ভিস লাগবে না)

- Paid **Cloudflare Queues** (`TASK_QUEUE`) এবং **R2** (`MEDIA_BUCKET`) সম্পূর্ণ বাদ দেওয়া হয়েছে।
- এখন সব ব্যাকগ্রাউন্ড জব **D1 `task_queue` টেবিলে** সেভ হয় এবং **Cloudflare Cron Triggers** প্রতিবার সর্বোচ্চ ৩টি পেন্ডিং জব নিরাপদ লকিং ও এক্সপোনেনশিয়াল ব্যাকঅফ সহ প্রসেস করে।
- মিডিয়া ও HTML আর্কাইভ ব্যাকআপ সরাসরি D1-এর `media_assets` টেবিলে সংরক্ষিত হয়।

---

## ধাপ ৪: GitHub ও Cloudflare Dashboard-এ Worker ডিপ্লয় করা

### পদ্ধতি ক: Cloudflare Dashboard-এর Git Integration দিয়ে (মোবাইল থেকে সহজ)
1. আপনার কোড GitHub রিপোজিটরিতে পুশ করুন (`.dev.vars` কখনো পুশ করবেন না)।
2. Cloudflare Dashboard-এ **Compute (Workers) > Workers & Pages**-এ যান।
3. **Create > Workers > Connect to Git** ক্লিক করে GitHub রিপোজিটরি সিলেক্ট করুন।
4. **Build configuration**-এ নিচের সেটিংস দিন:
   - **Root directory / Path:** `backend`
   - **Build command:** `npm ci && npm run lint`
   - **Deploy command:** `npx wrangler deploy`
5. **Save and Deploy** চাপুন।

### পদ্ধতি খ: GitHub Actions (`.github/workflows/cloudflare-deploy.yml`) দিয়ে
1. Cloudflare Dashboard-এ **My Profile > API Tokens > Create Token** থেকে **Edit Cloudflare Workers** টেমপ্লেট ব্যবহার করে একটি টোকেন তৈরি করুন (সাথে **D1: Edit** এবং **Account Settings: Read** পারমিশন দিন; আর কোনো Paid Queue/R2 পারমিশন লাগবে না)।
2. ড্যাশবোর্ডের ডানদিক থেকে আপনার **Account ID** কপি করুন।
3. আপনার GitHub রিপোজিটরির **Settings > Secrets and variables > Actions**-এ গিয়ে দুটি Secret যোগ করুন:
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
4. `main` ব্রাঞ্চে পুশ করলেই GitHub Actions অটোমেটিক টাইপচেক, টেস্ট, D1 মাইগ্রেশন এবং Worker ডিপ্লয় করে দেবে!

---

## ধাপ ৫: Cloudflare Secrets কনফিগার করা (Dashboard থেকে)

কখনোই কোডের ভেতরে API Key রাখবেন না। একাধিক API Key কমা (`,`) দিয়ে আলাদা করেও দিতে পারবেন (যেমন `GEMINI_API_KEYS`):
1. **Workers & Pages** > আপনার `autoblogger-ai-backend` ওয়ার্কার > **Settings** > **Variables and Secrets**-এ যান।
2. **+ Add** ক্লিক করে **Type: Secret** সিলেক্ট করে নিচের গোপন কী-গুলো যোগ করুন:

| Secret নাম | কাজ |
| :--- | :--- |
| `BACKEND_API_SECRET` | কমপক্ষে ৩২ অক্ষরের র‍্যান্ডম কী (Android অ্যাপের `X-API-Key`) |
| `SCHEDULER_SHARED_SECRET` | ম্যানুয়াল Cron/Queue ট্রিগারের জন্য গোপন কী |
| `FIREBASE_PROJECT_ID` | *(ঐচ্ছিক)* যদি Android অ্যাপ Firebase ID Token পাঠায় |
| `GEMINI_API_KEYS` (বা `GEMINI_API_KEY`) | এক বা একাধিক Google Gemini API Key |
| `OPENROUTER_API_KEYS` (বা `OPENROUTER_API_KEY`) | *(ঐচ্ছিক)* OpenRouter Failover API Key |
| `APINEX_API_KEYS` (বা `APINEX_API_KEY`) | *(ঐচ্ছিক)* API-NEX Key |
| `TAVILY_API_KEY` | Tavily Web Research API Key |
| `GOOGLE_OAUTH_CLIENT_ID` | Blogger, Search Console ও GA4 OAuth Client ID |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth Client Secret |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Google OAuth Refresh Token |
| `DEFAULT_BLOGGER_BLOG_ID` | আপনার Blogger ব্লগের ID |
| `GSC_SITE_URL` | Search Console সাইট URL (যেমন `https://example.blogspot.com/`) |
| `GA4_PROPERTY_ID` | GA4 Property ID (শুধু সংখ্যা) |
| `ADSTERRA_API_KEY` | *(ঐচ্ছিক)* Adsterra Publisher API Key |
| `FCM_SERVICE_ACCOUNT_JSON` | *(ঐচ্ছিক)* Android Push Notification-এর জন্য Firebase Service Account JSON |

---

## ধাপ ৬: Cron Triggers যাচাই করা

`backend/wrangler.jsonc`-এ ৩টি Cron Trigger আগে থেকেই সেট করা আছে:
- `*/15 * * * *` — প্রতি ১৫ মিনিটে অটোনোমাস ক্যাম্পেইন চেক ও বকেয়া রিট্রাই কিউ প্রসেসিং
- `50 23 * * *` — প্রতিদিন রাত ১১:৫০ UTC-তে ডেইলি অ্যানালিটিক্স ও ট্রাফিক ড্রপ বিশ্লেষণ
- `55 23 * * 0` — প্রতি রবিবার রাত ১১:৫৫ UTC-তে উইকলি অ্যানালিটিক্স, SEO অডিট ও কনটেন্ট আপডেট চেক

Cloudflare Dashboard > **Settings > Triggers > Cron Triggers** অংশে গিয়ে এগুলো সক্রিয় আছে কিনা দেখে নিন।

---

## ধাপ ৭: Worker URL সংগ্রহ ও Android Setup Wizard-এ সংযোগ

1. ডিপ্লয় সম্পন্ন হলে আপনার Worker পেজের উপরে লাইভ URL দেখতে পাবেন, যেমন:
   `https://autoblogger-ai-backend.<your-subdomain>.workers.dev`
2. মোবাইল ব্রাউজারে এই URL-এর শেষে `/health` যোগ করে খুলুন:
   `https://autoblogger-ai-backend.<your-subdomain>.workers.dev/health`
3. ব্রাউজারে `"status": "ok"`, `"service": "autoblogger-ai"`, `"platform": "cloudflare-workers"`, এবং `"dbConnected": true` দেখালে বুঝবেন ব্যাকএন্ড সঠিকভাবে চালু হয়েছে।
4. এবার আপনার **AUTOBLOGGER AI Android অ্যাপের Setup Wizard**-এ গিয়ে এই `https://...workers.dev` URL-টি দিন এবং **Verify Backend** চাপুন। অ্যাপটি রিয়েল `GET /health` যাচাই করে সফলভাবে কানেক্ট হবে!
