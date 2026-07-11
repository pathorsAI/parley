# 客戶戰情層（mini-CRM）— Design Doc

- **狀態**：Draft v1（待 review 後拆 issues）
- **日期**：2026-07-11
- **來源**：Brandon × Claude 三輪產品討論（pipeline 需求 → mini-CRM 需求 → 情報承載模型）
- **一句話**：讓 Parley 從「單場會議的教練」長出「跨會議的客戶戰情系統」——一個**從通話裡自己長出來的 CRM**，而且戰情會反過來餵回 live 教練（紅線守衛）。

---

## 1. 動機

業務實際的工作單位不是「一場會議」，是「一家公司裡的一群人、和幾條同時推進的局」。目前 Parley 每場會議是一筆獨立的 `HistoryEntry`，「這場跟誰開、屬於哪個案子、上次漏問什麼」全靠人腦。同時，業務手上真正值錢的是戰局分析（人物立場、籌碼對比、風險紅線、下一步槓桿順序——見附錄 A 的兩個真實範例形態），這種分析今天只能散落在筆記軟體裡，會過期、有錯誤、不可查證。

CRM 的死因是要人手動餵資料。Parley 的不對稱優勢是**它擁有最富的資料源（全程逐字稿）**：會後自動萃取、逐項審核入庫，資料保鮮問題從根本上被繞過。

## 2. 決策記錄（三輪討論拍板）

| # | 決策 | 內容 |
|---|------|------|
| D1 | 定位 | **A-lite**：Parley 自足的 mini-CRM（不是外部 CRM 的附庸），本機優先；schema 預留 `externalCrmId`，未來可單向推 Twenty/HubSpot |
| D2 | 實體骨架 | Company —< Person；Company —< Thread（戰線）；Meeting 掛 0..1 Thread；**會議出席者可跨公司**（通路場景：經銷商＋終端客戶同席） |
| D3 | 戰線（Thread） | Deal 泛化為「戰線」：`sales`（有 pipeline 階段、接 stage bundle）／`channel` 通路合作／`investment` 投資談判／`other`。非銷售型無 pipeline 階段。公司層可有不掛戰線的卡（如 AI3 人物盤點） |
| D4 | Deal 欄位 | 名稱、階段、狀態（進行中/贏/輸）、buying committee、開放問題、**預期簽約時間**；**不記金額** |
| D5 | Person | 限屬一家公司（換工作追蹤 = 以後）。分析維度：職稱、買方委員會角色、立場、KPI、concerns、摩擦力；「受誰影響」單欄位（不畫圖） |
| D6 | 證據鐵律 | 每個 AI 推論欄位必帶：證據引句＋出處會議＋時間點；標「AI 推測 vs 已確認」；顯示鮮度（最後支持證據的時間） |
| D7 | 承載模型 | **情報卡（claim）模型**：原子化卡片 + 頁面皆投影 + 散文戰報為生成式輸出（非儲存格式）。九分類（§4） |
| D8 | 寫入紀律 | **絕不自動寫入**：所有萃取以 diff 逐項審核（approve / edit / reject）後才入庫 |
| D9 | 紅線守衛 | 紅線卡 → live eval 注入，**進 MVP**（§7.3） |
| D10 | 關係圖 | 關係邊資料模型 day 1 就有（關係類卡片）；**視覺化圖 = 第二輪**，MVP 用實體頁關係清單 |
| D11 | Onboarding | 貼逐字稿 → 走 upload 通道成正式會議＋抽卡；雜項筆記 → 公司附件、只抽卡（MVP）。**訪談模式**（Parley 反問你補缺口）= 第二輪 |
| D12 | 入口 gating | 「客戶」區在 meetingType ∈ {sales, negotiation, partnership} 時顯示；general（面試等場景）完全隱藏 |
| D13 | 同步 | MVP：本機＋既有**個人**雲同步；org 共享 = 第二輪（含個資原則 §9） |
| D14 | 排序 | 實體層先行（做薄）；stage bundle（SPIN 缺口板/幽靈列/建議問法）為並行工作流，掛接點見 §8 |
| D15 | Anti-goals | 不做：email 同步、名單開發/sequence、報價單、任務提醒系統、lead scoring |

## 3. 資料模型

沿用 `src/lib/types.ts` 的風格。實體薄、分析厚——分析內容一律以情報卡承載，實體上的分析欄位（如 `stance`）只是**投影快取**，真相在卡片。

```ts
/** 客戶公司（或任何在戰局裡出現的組織：夥伴、競品、通路）。 */
interface Company {
  id: string;
  name: string;
  aliases: string[];          // 「派司」「Pathors」— 供轉錄比對
  note: string;               // 一句話定位（自由文字）
  externalCrmId?: string;     // D1: 預留
  createdAt: number;
  archived: boolean;
}

/** 人，隸屬一家公司（D5）。 */
interface Person {
  id: string;
  companyId: string;
  name: string;
  aliases: string[];          // 「貴哥」「Jasper」「俊哥」
  title: string;              // 職稱/部門
  /** 買方委員會角色（MEDDICC 語彙）。投影快取，由審核流程更新。 */
  committeeRole?: "economic" | "champion" | "influencer" | "user" | "gatekeeper" | "blocker";
  /** 立場投影快取：最新一張已生效 stance 卡的值。 */
  stance?: { value: "support" | "neutral" | "oppose"; confidence: "confirmed" | "inferred"; updatedAt: number };
  /** 受誰影響（D5：單欄位不畫圖）。 */
  influencedBy: string[];     // personIds
  createdAt: number;
  archived: boolean;
}

/** 戰線：一家公司下可多條並行（D3）。sales 型接 pipeline 階段與 stage bundle。 */
type ThreadKind = "sales" | "channel" | "investment" | "other";
type SalesStage = "discovery" | "demo" | "proposal" | "negotiation" | "closing";

interface Thread {
  id: string;
  companyId: string;
  /** 跨公司局的其他參與組織與其角色（D2，通路場景）。 */
  companyRoles: { companyId: string; role: "customer" | "distributor" | "partner" | "competitor" }[];
  kind: ThreadKind;
  name: string;               // 「光陽案報價」「投資議題」「程曦上櫃合作」
  status: "active" | "won" | "lost" | "parked";
  stage?: SalesStage;         // 僅 kind === "sales"
  customStatus?: string;      // 非 sales 型的自由階段描述
  expectedCloseAt?: number;   // D4: 預期簽約時間（無金額）
  /** buying committee：personId → 在此戰線的角色（可與 Person.committeeRole 不同局不同）。 */
  committee: { personId: string; role: Person["committeeRole"] }[];
  createdAt: number;
}
```

### 3.1 情報卡（Claim）——系統的原子

```ts
type ClaimCategory =
  | "stance"       // 立場（含深層動機、恐懼、談判習慣）
  | "relation"     // 關係邊：主詞→受詞，帶方向與標籤（投資意向 20–30%、案源、老同事）
  | "leverage"     // 籌碼，side: ours | theirs（含 BATNA、時間壓力、錨）
  | "goal"         // 目標，side: ours | theirs × layer: surface | deep
  | "risk"         // 風險（收編、定價陷阱、合約、現金流）
  | "redline"      // 紅線：不可揭露的資訊／不可越的線 → live 守衛（§7.3)
  | "competitor"   // 競情（價目、強弱點、攻擊點）
  | "nextmove"     // 下一步（有順序 rationale 的行動，非待辦）
  | "openq";       // 待查證（第三家是誰？會議時間衝突！）

type ClaimConfidence = "confirmed" | "inferred" | "conflicted";

type ClaimProvenance =
  | { kind: "meeting"; historyId: string; quote: string; atMs?: number }
  | { kind: "import"; attachmentId: string; quote?: string }
  | { kind: "user" };  // 你手動斷言

interface Claim {
  id: string;
  companyId: string;
  threadId?: string;          // 不掛戰線 = 公司層卡（D3）
  subjects: string[];         // personIds / companyIds，可多掛
  category: ClaimCategory;
  side?: "ours" | "theirs";   // leverage / goal 用
  layer?: "surface" | "deep"; // goal 用
  text: string;               // 一句話一條主張
  provenance: ClaimProvenance[];  // 可累積多個支持證據
  confidence: ClaimConfidence;
  /** 生效狀態。錯誤/被推翻的卡保留（可追溯「當初為什麼這樣以為」）。 */
  status: "active" | "superseded" | "wrong";
  supersededBy?: string;      // claimId
  conflictsWith?: string[];   // claimIds — 衝突偵測（§6.4）
  createdAt: number;
  /** 鮮度：最後一次有證據支持的時間（D6）。UI 上過舊的卡降飽和度。 */
  lastSupportedAt: number;
}
```

### 3.2 會議連結（HistoryEntry 增欄）

```ts
// HistoryEntry 新增（皆 optional，向後相容舊紀錄）：
threadId?: string;
companyIds?: string[];
/** 出席者：person ↔ 轉錄 speaker 的綁定（speakerKey = source+speaker#，同 speakerNames 的 key）。 */
attendees?: { personId: string; speakerKey?: string }[];
/** 被提及但不在場的人（會後 diff 會建議建檔）。 */
mentionedPersonIds?: string[];
```

### 3.3 附件

```ts
interface CompanyAttachment {
  id: string; companyId: string;
  name: string; kind: "note" | "chatlog" | "doc";
  text: string;               // MVP 只收純文字貼上
  createdAt: number;
}
```

## 4. 呈現層——頁面都是卡片的投影

### 4.1 導覽

新增第三個 app 區「**客戶**」（現有 `appMode: live | replay` 加 `accounts`），TitleBar 進入。依 D12 gating：`settings.meetingType` 為 general 時入口隱藏（資料保留不刪）。

### 4.2 頁面

- **公司列表**：名稱、進行中戰線數、最近會議、待釐清數（衝突卡）。
- **公司頁**（戰情總覽）：
  - 頂部：**待釐清**（`conflicted` 與高優先 `openq` 卡）——強制先看見打架的資訊；
  - 人物盤點（person 卡片牆：職稱／委員會角色／立場 chip／鮮度）；
  - 戰線列表（各自階段/狀態）；
  - 公司層卡片分區（籌碼對比 ours/theirs 兩欄、目標表裡、風險紅線）；
  - 會議時間軸；附件。
- **人頁**：基本檔＋六維度投影（每格 = 該分類的 active 卡，含證據引句、可點回會議時間點）＋「受誰影響」＋此人出席過的會議。
- **戰線頁**（作戰室）：階段、buying committee、開放問題（openq 卡）、競情卡、下一步序列、紅線、掛在此戰線的會議。
- **生成式戰情簡報**：每個公司頁/戰線頁一顆「產出戰情簡報」→ LLM 把 active 卡寫成附錄 A 品質的散文（人物盤點→籌碼→目標→風險紅線→下一步槓桿順序），markdown 匯出。**文件是輸出品，不是儲存格式**——更正永遠改卡。

### 4.3 每張卡的通用 affordance

點開看證據（引句→跳轉該場會議時間點）／標「已確認」／標「錯誤」（留史）／編輯（變 user-asserted）／改掛戰線。

## 5. 核心流程

### 5.1 Onboarding：新公司開檔（D11）

建立公司 → 「餵資料」步驟：
1. **貼逐字稿**（可多份）：走新的純文字 ingest 路徑，各自建立 `HistoryEntry(source:"upload", audio:null)`，segment 時間軸為合成值（無音檔時 replay/seek 功能優雅降級）→ 享有完整分析＋抽卡。
2. **貼雜項**（LINE 對話、筆記、別的 AI 寫的分析）：存 `CompanyAttachment`，只跑抽卡。
3. 抽卡結果進 **diff 審核**（§5.4 同一套 UI）→ 公司戰情初版誕生。
4. ⚠️ 外部貼入的分析（如既有的 AI3 戰報）一律以 `inferred` 入庫，不因為寫得斬釘截鐵就當 `confirmed`。

第二輪加**訪談模式**：Parley 反問（「決策者是誰？」「有競品了嗎？」）補缺口——本質是缺口引擎在會前跑，先讓貼資料這條路順。

### 5.2 會前

`MeetingContextButton` 的 dialog 升級：選公司 →（可選）戰線 → 出席者（可現場快速新增 person）。選定後 **brief 自動組**：deal 狀態＋出席者檔案（立場/KPI/上次 concerns）＋公司層立場＋開放問題＋紅線提示，寫入 `meetingContext`（可手動再編輯）。取代手打。

### 5.3 會中

- 紅線守衛（§7.3）。
- 出席者的 speakerKey 綁定沿用現有 speaker 命名 UI，補「綁到 person」一步。
- （第二輪）in-call person 小卡：板上顯示在場者立場/KPI 摘要。

### 5.4 會後：diff 逐項審核（D8——本系統唯一的寫入通道）

會議結束、分析 settle 後（沿用 org 自動分享的 settle 時機），跑萃取 pass：現有 active 卡作為 context，輸出**操作提案**清單：

| 操作 | 例子 |
|------|------|
| `add` | 新卡：「Will 擔心規格需求外流」（stance, inferred, 引句） |
| `support` | 既有卡新增支持證據、刷新鮮度 |
| `supersede` | 「Joyce 說會議是週四 11:00」推翻舊卡 |
| `conflict` | 新資訊與既有卡打架 → 兩張都標 conflicted，浮到待釐清 |
| `suggest-person` | 「我要回去問我們採購」→ 建議建檔（採購, gatekeeper?) |
| `match-attendee` | 轉錄 speaker ↔ person 綁定建議 |
| `update-thread` | 階段推進建議、開放問題增刪、下一步 |

審核 UI：逐項 approve / edit / reject，可全選。**reject 不留痕、approve 才入庫**。目標：一場會議的審核 < 3 分鐘。

## 6. 萃取與衝突

- 萃取用現有 `generateObjectResilient` + zod schema（同 intel/todos 模式），prompt 注入現有卡片庫（active 卡的壓縮表示）以支援 support/supersede/conflict 判斷。
- 衝突偵測 MVP 交給 LLM（prompt 內明確要求比對新舊主張）；不另建規則引擎。
- 卡片文字語言跟隨轉錄語言（zh-TW 為主）。
- 萃取範圍限 professional（§9 個資原則直接寫進 system prompt）。

## 7. Live 整合

### 7.1 會議 ↔ 戰線

會議掛上 sales 型戰線時，`meetingType` 自動設 sales、戰線的 `stage` 成為該場的預設階段模板（stage bundle 掛接點，§8）。

### 7.2 開放問題 → checklist 種子

戰線的 `openq` 卡自動 seed 該場 TODO 清單（沿用現有 todo 自動勾選機制）——上一場漏問的，下一場自動變成待辦。這就是先前討論的「輕量續打」，在實體模型下免費得到。

### 7.3 紅線守衛（D9，MVP）

會議掛戰線時，該戰線＋公司層的 active `redline` 卡轉為該場的動態 `EvalDef`（severity critical，prompt 形如「若 ME 提及或暗示【成本底價／Qwen】即 flag」）注入 evaluations。走既有 eval 引擎與 finding 呈現，零新管線。會議結束時動態 eval 移除。

## 8. 與 stage bundle 工作流的關係（D14，並行線）

先前討論的銷售 pipeline 體驗（階段選單、SPIN 缺口板、幽靈列＋建議問法、下一步守門員、stage-aware talk-ratio）是**另一條並行工作流**，本文件只定義掛接點：

- 階段的家 = `Thread.stage`（sales 型）；會議模板依它預設。
- stage bundle（板 schema＋checklist＋eval 集）依 `SalesStage` 切換；資料驅動、Settings 可編輯（沿用 todo/eval template 機制）。
- 細節（SPIN slot 定義、缺口視覺化、建議問法生成）見 **[stage-bundles.md](./stage-bundles.md)**（#137）。

## 9. 儲存、同步、個資

- **儲存**：仿 history 模式——Rust 側 JSON 檔，`accounts/` 下 index + 每公司一檔（company + persons + threads + claims + attachments）。每檔 dirty flag。
- **同步**：MVP 走既有**個人**雲同步通道（同 history entry 的 push/pull + dirty sweep）；org 共享第二輪。
- **個資原則**（org 共享前就生效，寫進萃取 prompt 與 doc）：
  1. 只記商務上必要的 professional 判斷（立場、KPI、concerns）；
  2. 禁止萃取敏感個資類別（健康、政治傾向、私生活）；
  3. person 檔案整檔可刪；
  4. 推測欄位永遠標示為推測。

## 10. MVP 切分

**Phase 1（本文件的 MVP）**
1. 實體層＋claim store＋儲存/個人同步
2. 「客戶」區四個頁面（列表/公司/人/戰線）＋卡片 affordance＋待釐清
3. Onboarding 餵資料（貼逐字稿的純文字 ingest＋附件）＋抽卡審核
4. 會前 picker＋brief 自動組
5. 會後 diff 逐項審核
6. 紅線守衛＋openq→checklist 種子
7. 生成式戰情簡報（markdown 匯出）

**Phase 2**
訪談 onboarding／關係視覺化圖（react-flow 之類）／org 共享（含權限與個資檢查）／in-call person 卡／pipeline 看板／外部 CRM 推送（Twenty 優先）／聲紋身份比對／stage bundle 深度整合（另文）

## 11. 成功指標

- 會前準備時間：< 2 分鐘（brief 自動組）
- 會後入庫審核：< 3 分鐘/場
- 卡片可查證率：100% 帶出處
- 紅線守衛：每月至少一次「真的攔到」（用戶回報）
- 主觀：Brandon 能在 Parley 裡維護 AI3／喜來登等級的戰局分析，不再另開筆記軟體

## 12. 開放問題

1. 「戰線」的 UI 用詞（戰線/案子/局？）與 en 對應詞（Thread/Track?）
2. 同名 person 跨公司的極端情況（MVP：手動）
3. 卡片庫變大後生成簡報的 context 預算（分區生成？）
4. 純文字逐字稿 ingest 的 speaker 標記格式約定（「我：/對方：」？自由格式讓 LLM 切？）
5. general 模式下已掛戰線的舊會議在 history 的呈現

---

## 附錄 A：目標品質基準

兩份真實戰報（AI3 通路/投資局、新竹喜來登競標局）作為「生成式戰情簡報」的品質基準與資訊類型來源，內容含：人物盤點與立場（含深層動機/恐懼/談判習慣）、籌碼對比（含 BATNA/時間壓力不對稱/錨）、雙方目標表裡、風險與資訊紅線、競品卡（含價目情報）、下一步槓桿順序、待查證清單（含資訊衝突——兩個窗口講的會議時間不同）。原文存於 Brandon 的討論記錄，不入 repo。
