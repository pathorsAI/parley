// Seeds the App Review / screenshot account with realistic-looking meetings.
// Content is fictional but written the way real B2B meetings actually sound —
// screenshots should show the product doing its job, not a placeholder.
// No real companies, people, or customer data appear anywhere.
//
// Usage: PARLEY_REVIEW_TOKEN=<reviewer account API token> node seed-demo.mjs
//
// The token comes from the environment rather than a file under /tmp: that
// directory is world-writable, so any local process could swap the token out
// from under this script. Pull the value from the approved secret manager at
// call time (see README step 6) and never write it into the repository.

const TOKEN = process.env.PARLEY_REVIEW_TOKEN?.trim();
if (!TOKEN) {
  console.error(
    "PARLEY_REVIEW_TOKEN is not set — export the reviewer account's API token before running this script."
  );
  process.exit(1);
}

const API = "https://api.parley.tw";

const seg = (i, speaker, text, startMs, endMs) => ({
  id: `mix-${i}`,
  source: "mix",
  speaker,
  text,
  isFinal: true,
  startMs,
  endMs,
});

const meetings = [
  {
    id: "a1c9f2e0-4b71-4f28-9c33-6d2b8e5a1074",
    title: "續約條件討論",
    daysAgo: 1,
    hour: 14,
    minute: 30,
    durationMs: 27 * 60 * 1000 + 12_000,
    speakerNames: { "mix-1": "我", "mix-2": "客戶窗口" },
    segments: [
      [1, "今天主要想先確認續約的範圍，明年度你們大概會用到幾個席次？", 4_200, 9_800],
      [2, "現在是十二個，明年業務團隊會再擴一組，抓十八到二十。", 10_400, 17_600],
      [1, "了解。二十席的話會落在我們的成長方案，單價會比現在低一階。", 18_200, 25_400],
      [2, "價格是一個考量，不過我更在意的是導入時間。上次那批新人花了快三週才上手。", 26_100, 36_800],
      [1, "這次我們可以安排一場兩小時的團訓，另外給你們一份內部的操作手冊範本。", 37_500, 46_900],
      [2, "如果訓練能排在一月的第一週，對我們最好，因為第二週就要開始跑季度目標。", 47_600, 58_300],
      [1, "第一週沒問題，我這邊先把日期卡下來。付款方式想維持年繳嗎？", 59_000, 67_200],
      [2, "年繳可以，但希望發票能分兩期開，會計那邊比較好處理。", 68_100, 76_400],
      [1, "分兩期沒問題，簽約時開一半，四月再開一半。", 77_000, 83_600],
      [2, "那我這週把需求整理好給採購，下週我們再對一次細節。", 84_300, 93_100],
      [1, "好，我今天會把方案書和訓練時程一起寄給你。", 94_000, 100_800],
    ],
  },
  {
    id: "b7d4e8a2-91c6-4a55-8e17-3f0c5b9d2e46",
    title: "新客戶需求訪談",
    daysAgo: 3,
    hour: 10,
    minute: 15,
    durationMs: 41 * 60 * 1000 + 38_000,
    speakerNames: { "mix-1": "我", "mix-2": "客戶窗口" },
    segments: [
      [1, "想先了解一下，你們現在的會議紀錄是怎麼做的？", 3_800, 9_200],
      [2, "老實說沒有很系統。業務自己抄筆記，回來再打進 CRM，常常隔兩三天才補。", 9_900, 21_400],
      [1, "那中間如果有人離職，那些對話的脈絡等於就不見了。", 22_000, 28_600],
      [2, "對，這就是我最頭痛的地方。上個月才發生過，接手的人完全不知道前面談到哪。", 29_300, 40_100],
      [1, "你們一週大概有多少場客戶會議？", 40_800, 45_200],
      [2, "六個業務，一個人一週三到五場，加起來大概二十五場上下。", 46_000, 55_800],
      [1, "如果這些都有逐字稿，而且能自動整理成重點，對你們最大的差別會是什麼？", 56_500, 66_300],
      [2, "主管不用每個案子都問一遍。現在光是週會就要花一個半小時對進度。", 67_000, 78_400],
      [1, "了解。那導入的話，資安這關會需要走什麼流程？", 79_100, 86_200],
      [2, "要過一次資安問卷，還有資料存放地點的說明。這個大概兩週。", 87_000, 96_500],
      [1, "沒問題，我們有現成的文件可以提供。我這邊先安排一場給業務團隊的試用。", 97_200, 107_800],
      [2, "可以，先找兩個業務試，如果他們覺得有用，推起來會快很多。", 108_500, 118_900],
    ],
  },
];

const dayMs = 24 * 60 * 60 * 1000;

for (const m of meetings) {
  const d = new Date(Date.now() - m.daysAgo * dayMs);
  d.setHours(m.hour, m.minute, 0, 0);
  const createdAt = d.getTime();
  const segments = m.segments.map(([speaker, text, s, e], i) =>
    seg(i, speaker, text, s, e)
  );
  const snippet = segments[0].text;
  const speakers = new Set(segments.map((s) => `${s.source}-${s.speaker}`)).size;

  const summary = {
    id: m.id,
    title: m.title,
    source: "live",
    createdAt,
    durationMs: m.durationMs,
    speakerCount: speakers,
    findingsCount: 0,
    actionItemsCount: 0,
    hasAudio: false,
    snippet,
    folderId: null,
  };
  const meta = {
    id: m.id,
    title: m.title,
    source: "live",
    createdAt,
    durationMs: m.durationMs,
    segments,
    speakerNames: m.speakerNames,
    findings: [],
    actionItems: [],
    meetingContext: "",
    meetingBatna: "",
    meetingTarget: "",
    meetingFloor: "",
    audio: null,
    analyzed: false,
  };

  const res = await fetch(`${API}/recordings/${m.id}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ summary, meta }),
  });
  console.log(res.status, m.title, `${segments.length} segments`);
}
