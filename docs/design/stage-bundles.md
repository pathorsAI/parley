# Stage Bundles — 銷售階段工作流（SPIN 缺口板與階段教練）— Design Doc

- **狀態**：Draft v1（提案，待 Brandon review 逐條拍板後拆實作票）
- **日期**：2026-07-11
- **來源**：pipeline 三輪討論的並行工作流（mini-crm.md D14/§8 預留的掛接點）；issue #137
- **一句話**：把 pipeline 從「stepper＋靜態指南」升級成**會看缺口的階段教練**——每個階段一個 bundle（缺口板＋教練規則＋退出條件），板上的空格自己會說話，教練在對的時機提醒你問對的問題、鎖住下一步。

---

## 1. 動機

pipeline lite（#133 已出貨）給了 sales 戰線：可點的 stage stepper、每階段的靜態指南（目標／該收集什麼／退出條件）、openq 卡自動 seed 待辦。這解決了「知道現在在哪一階段」，但沒解決業務真正的痛：

1. **看不見負空間**。指南列了「該收集什麼」，但收集到沒有、收集得夠不夠厚，要自己對著卡片庫心算。Discovery 結束才發現 implication 一格是空的，已經來不及。
2. **知道缺什麼 ≠ 知道怎麼問**。「去量化痛點的商業後果」是正確的廢話；業務需要的是**接著對方剛講的話**的下一句。
3. **會議會自己漂**。聊得開心 → 沒鎖下一步就掛電話；pain 還沒量化 → 被拉去報價。這些都是「當下沒有人拉你一把」的失誤，事後檢討沒有用。
4. **真教練跟填表機的差異在品質判斷**。SPIN 跑完順序不代表跑對：implication 是你自己講的（客戶沒認領）就不算數。

CRM 世界把這叫 sales methodology enforcement，做法是表單必填欄位——填表機。Parley 的不對稱優勢還是那個：**它在聽**。板可以從對話自己長出來，教練可以在對話裡當下介入。

## 2. 提案決策（S1–S12 待逐條拍板；S13–S14 已拍板 2026-07-11）

| # | 提案 | 內容 |
|---|------|------|
| S1 | Bundle 是資料 | 一個階段 = 一個 **StageBundle**：板 schema（slots）＋教練規則＋退出條件＋預設時長＋talk-ratio 目標。資料驅動，非寫死元件；builtin 五階段出廠，使用者可改（S9） |
| S2 | 板是投影不是儲存 | **slot 內容 = claim base 的查詢投影**。單一真相仍是情報卡（mini-crm D7）；板不新增儲存格式，空/薄/實由掛到 slot 的卡算出。卡片新增 `slotIds?: string[]` 輕量標籤（S3） |
| S3 | slot 歸屬混合判定 | 新卡在**萃取時**就帶 slot（bundle 的 slot 清單注入抽取 prompt）；舊卡/手動卡用 slot 的粗查詢（category/side/layer）兜底＋開板時一次性補分類（快取）。純規則映射不可行：SPIN 四格與九分類不是一對一 |
| S4 | 建議問法即時生成 | 點幽靈列 → 即時生成 2–3 句問法（不預存）。輸入=slot 定義＋該 slot 已有的卡＋逐字稿尾段（對方剛講的話）；輸出沿用 finding「怎麼回」的 `SolutionReply` 形態（kind/reply/consideration）與 UI pattern |
| S5 | 教練規則跑既有 eval 引擎 | 會中規則（守門員、過早報價、SPIN 順序）比照紅線守衛：bundle → 動態 `EvalDef` 注入（`stagecoach:` 前綴），會議開始注入、結束移除。**零新管線**；本地可判的（talk-ratio、時間）走 delivery monitor 模式不花 AI |
| S6 | 時間預算 | 會議連結戰線時可設「預計時長」（預設值來自 bundle）。下一步守門員在剩 ~20% 時間、且本場尚無「具體有日期的下一步」時觸發；觸發時機用 prosody 挑空檔（`!speaking && !farendActive`，沿用 delivery monitor 的 sustained-condition 機制） |
| S7 | Talk ratio 是本地計算 | per-stage 門檻放 bundle（discovery：我方 <40%、獨白 >60s；demo 反轉）。計算沿用表達記分卡/delivery monitor 的本地訊號（`speaking`、`farendActive`、segment 歸屬），零 AI 成本 |
| S8 | 階段自動建議＝建議不代辦 | 會中：偵測「實際對話階段 ≠ 所選模板」→ 低頻提示切換（piggyback 在情報板抽取 pass 上，不另開呼叫）。會後：`update-thread` 操作提案（#134 既有項）建議推進階段。**永不自動推進** |
| S9 | 儲存沿用 template 機制 | bundles 存 config-dir `stage-bundles.json`（builtin 常數＋user override，同 todo/eval template 的 builtin/可編輯模型）。Settings 編輯器＝P3；org 共享 playbook 是這個檔案的同步問題，掛 mini-crm D13 第二輪 |
| S10 | 警示紀律 | 每條規則帶 `cooldownSec`＋每場觸發上限；transient 提示優先於 finding（不進時間軸）；同時最多一則。教練不可以變 nag——寧可漏提醒不可吵 |
| S11 | Gating | 缺口板只在「會議連結了 sales 戰線」時出現（live 右欄）；沒連戰線的 sales 會議維持現有情報板。戰線作戰室（ThreadPage）的板不受會議狀態限制，常駐 |
| S12 | Anti-goals | 不做：forecast/加權金額、stage 自動推進、lead scoring、方法論考核報表（對 rep 的 SPIN 成績單）、多方法論框架切換（MEDDICC checklist 等＝bundle 內容問題，不是新機制） |
| S13 | 板上用詞 ✅拍板 | 直接用 SPIN 術語：格頭 = **S / P / I / N**（tooltip 全稱 Situation/Problem/Implication/Need-payoff），不翻成白話；en 同術語。幽靈列 hint 維持白話說明句 |
| S14 | live 板語氣 ✅拍板 | live 右欄由 sales 情報板**直接升級**為 bundle 板（不並列 tab）。live 的主語氣是 **fill 不是 gap**——重點是「這場問到的情報有哪些已經可以填上」：新抽內容即時落格（提案中樣式＋落格 highlight）。負空間視覺（幽靈列整行）以作戰室（會前）為主場，live 只在格頭以狀態點輕量提示。objection/commitment 追蹤保留於板下 |

## 3. 資料模型

沿用 `src/lib/types.ts` 風格。**bundle 是設定資料**（同 `EvalTemplate` 一家人），不進 accounts.json。

```ts
/** 缺口板上的一格。id 以 bundle 命名空間：`discovery.problem`。 */
interface SlotDef {
  id: string;
  /** 格名（SPIN 的 S/P/I/N，或 demo 的「成功標準」…）。 */
  label: string;
  /** 這格要裝什麼——同時是幽靈列文案與萃取/補分類的語意提示。 */
  hint: string;
  /** 兜底粗查詢：符合條件的既有卡預掛進來（S3）。 */
  query: {
    categories: ClaimCategory[];
    side?: "ours" | "theirs";
    layer?: "surface" | "deep";
  };
  /** 「實」門檻：至少幾張非過期卡（預設 2）；confirmed 一張即算實。 */
  solidAt?: number;
}

/** 會中教練規則。local 型不花 AI；eval 型注入既有 eval 引擎（S5）。 */
type CoachRuleDef =
  | {
      kind: "nextstep-gate";        // S6 下一步守門員
      triggerAtRemainingPct: number; // 預設 20
      cooldownSec: number;
    }
  | {
      kind: "premature-pricing";    // 過早報價（discovery bundle 專屬）
      /** 先用關鍵字粗篩（報價/價格/多少錢/quote/pricing）再交 eval 確認。 */
      guardSlots: string[];          // 這些 slot 還空/薄時才觸發，例 ["discovery.problem","discovery.implication"]
      cooldownSec: number;
    }
  | {
      kind: "spin-order";           // SPIN 順序品質（eval 型）
      prompt: string;                // 判準寫在 bundle 裡，可編輯
      cooldownSec: number;
    }
  | {
      kind: "talk-ratio";           // S7（local 型）
      meMaxPct?: number;             // discovery: 40
      meMinPct?: number;             // demo: 55（反向）
      monologueSec: number;          // 獨白上限，預設 60
    }
  | {
      kind: "stage-mismatch";       // S8 會中版（piggyback 情報板 pass）
      cooldownSec: number;
    };

interface StageBundle {
  stage: SalesStage;
  boardTitle: string;               // 「SPIN 缺口板」「Demo 對焦板」…
  slots: SlotDef[];
  /** 退出條件（沿用現有 stageGuide.exit 文案，升級為可勾核對）。 */
  exitCriteria: string[];
  coachRules: CoachRuleDef[];
  defaultDurationMin?: number;      // S6 預計時長預設值
}

/** 出廠五份（S1）；user override 存 config-dir stage-bundles.json（S9）。 */
type StageBundleFile = { version: 1; overrides: Partial<Record<SalesStage, StageBundle>> };
```

`Claim` 增一個 optional 欄位（向後相容，accounts.json 不 migration）：

```ts
interface Claim {
  // …既有欄位…
  /** 缺口板 slot 標籤（S3）。萃取時標；補分類/手動掛也寫這裡。 */
  slotIds?: string[];
}
```

### 3.1 builtin discovery bundle（SPIN 板）草案

| slot | label（S13：直接用術語） | hint（同幽靈列文案） | 兜底 query |
|------|-------|---------------------|-----------|
| `discovery.situation` | **S**（Situation） | 對方現在怎麼做這件事：既有流程/系統/供應商、規模與分工 | goal(surface,theirs), relation |
| `discovery.problem` | **P**（Problem） | 對方**自己說出**的不滿與困難——誰在痛、痛在哪個環節 | risk(theirs), stance |
| `discovery.implication` | **I**（Implication） | 痛不解決的量化代價：錢/時間/風險/機會成本。**必須是客戶認領的**，我方推算的標「薄」 | risk, goal(deep,theirs) |
| `discovery.needpayoff` | **N**（Need-payoff） | 對方自己說出「解掉會多好」；理想是他替你講方案價值 | goal(deep,theirs), nextmove |
| `discovery.committee` | 決策鏈 | 誰拍板、誰把關、誰反對——沿用委員會角色 | stance, relation |

（demo／proposal／negotiation／closing 的板各 4–5 格，內容自現有 `stageGuide.*.collect` 文案升級，實作時逐格定稿——文案已有 zh/en 兩份，見 §7 i18n 議題。）

## 4. 缺口板 UI

### 4.1 形態：格子＝已收集摘要＋幽靈列

每格顯示：
- **已掛的卡**（依 lastSupportedAt 新→舊）：一行一卡，信心 chip（已確認/推測/衝突）＋首條證據引句（hover 全文）。點卡＝既有 ClaimCard affordance（編輯/確認/標錯/改掛）。
- **幽靈列**（負空間視覺）：slot 未達「實」時，最後一列以虛線框＋淡字顯示 `hint`——一眼掃過去，哪格薄立刻浮出來。點幽靈列 → 建議問法（§5）。幽靈列是**作戰室板（會前）的主視覺**；live 板的呈現反轉為 fill 語氣，見 S14。
- **格狀態**：空（0 卡）／薄（只有 inferred、或全部過舊 >30 天、或未達 `solidAt`）／實。狀態只影響視覺（薄=琥珀點、實=綠點、空=虛線），**不做分數**（S12）。

### 4.2 兩個家

- **戰線作戰室（ThreadPage）**：板取代現有靜態 stage guide 區塊（指南的 goal/exit 保留為板的頭尾）。會前看板知道這場要補什麼，會後 diff 入庫的卡即時反映（#143 的 recentIngest highlight 直接沿用）。
- **Live 右欄（S11／S14 ✅直接升級）**：會議連結 sales 戰線時，右欄的 sales 情報板升級為 bundle 板。**live 的主語氣是 fill**：你問到的情報即時落格——本場新抽內容以「提案中」樣式飛進對應格，落格瞬間 highlight（視覺語彙同 #143 recentIngest），會後審核 approve 才真正入庫（D8 不破）。負空間在 live 不搶戲：不顯示幽靈列整行，只在格頭用狀態點（空/薄/實）輕量提示；點格頭仍可叫出建議問法。objection/commitment 追蹤保留為板下方第二區（互補不衝突）。

### 4.3 live 更新路徑

live 情報板抽取（`runIntelExtraction`）已是全文重算模式。sales＋戰線場景下，抽取 schema 增列 `slotFills`：每項＝{slotId, text, quote, speaker}，**只進 UI 暫態**（提案中樣式），不寫 claim base。會後 diff 審核時同一批內容以正式 ops 出現（帶 slotIds），approve 才入庫——live 看得到、資料不髒。

## 5. 建議問法（點缺口 → 怎麼問）

- **觸發**：點幽靈列或點格頭的「怎麼問」。
- **輸入**：slot `hint`＋該 slot 已有的卡（避免問已知）＋逐字稿尾段（~最後 2 分鐘，含說話者歸屬）＋出席者稱謂。
- **輸出**：2–3 句，沿用 `SolutionReply` 形態：`reply`（可直接照唸的 zh-TW 商務語感問句，**接著對方剛講的話**）＋`consideration`（一行：這句在釣什麼）。`kind` 沿用 wargame 分類或增列 `probe`。
- **語感鐵則**（寫進 prompt）：跟上對話脈絡（引用對方剛說的詞）、開放式優先、一次一問、不像問卷。罐頭句（「請問您的預算是多少」）＝失敗案例。
- **UI**：重用 FindingSolution 的卡片樣式與 lazy cache（per slot × transcript 尾段 hash）。
- **會外**（作戰室開板、沒在通話）：同一入口，脈絡改為「下次會議的開場問法」，輸入不含逐字稿尾段。

## 6. 會中教練規則細節

| 規則 | 型 | 觸發 | 呈現 |
|------|----|------|------|
| 下一步守門員 | local | elapsed ≥ (1−20%)×預計時長，且本場未出現「具體＋有日期」的下一步（commitments/nextmove 提案均無日期），且處於空檔（`!speaking && !farendActive` 持續 ≥2s） | transient 警示：「剩 ~N 分鐘，下一步還沒鎖日期」＋一鍵帶出建議收尾問法（§5 引擎，slot=nextstep） |
| 過早報價 | local 粗篩 + eval 確認 | stage=discovery，價格詞出現且 `guardSlots` 仍空/薄；粗篩命中才起 eval 判斷是誰把話題拉去價格、pain 是否已量化 | 教練提示：拉回問法（§5）或「切到報價階段模板？」雙選項 |
| SPIN 順序品質 | eval | ME 在 I 格空/薄時開始推銷方案價值；或 implication 全部出自 ME 之口、客戶未認領 | finding（info 級）＋一行糾偏：「後果還是你講的——讓他自己說一次」 |
| Talk ratio | local | 滾動窗口 ME 發言占比越過 bundle 門檻；獨白 > `monologueSec`（沿用 steamroll 機制，門檻 per-stage 化） | 既有 delivery 提示樣式，文案帶階段脈絡（「Discovery 是聽的階段」） |
| 階段錯位 | piggyback | 情報板 pass 順帶回傳 detectedStage；連續兩次 ≠ 所選階段才提示（防抖） | 低調 banner：「聽起來已經在談報價——切換模板？」點了才切（S8） |

共通：`cooldownSec` 預設 300、每場每規則最多 2 次、同時最多顯示一則（佇列丟棄不排隊）、transient 不進時間軸不留檔。

## 7. 儲存、i18n、同步

- **儲存**：builtin bundles 為程式常數（文案走 i18n key，沿用現 `stageGuide.*` 的 zh/en 資產升級）；user override 存 config-dir `stage-bundles.json`（raw string，不 i18n——你改成什麼就是什麼）。讀取合併：override 有該 stage 就整份蓋（不做 per-slot merge，簡單可預測）。
- **Settings 編輯器**（P3）：比照 eval template 編輯器——列表＋編輯 slot 文案/門檻/規則開關。P1–P2 期間 builtin 即全部。
- **同步**：跟 todo/eval template 同命運（目前本機）；org 共享 playbook＝把這個檔案納入 mini-crm D13 第二輪的 org 通道，本文不展開。

## 8. 分期

**P1 — 板先能看（作戰室，無 live 依賴）**
1. `StageBundle` schema＋builtin discovery bundle（SPIN 板）＋其餘四階段以現有 stageGuide 文案粗轉
2. `Claim.slotIds`＋萃取帶 slot（餵資料/會後 diff 兩條路都標）＋開板一次性補分類（快取）
3. ThreadPage 缺口板（取代靜態指南）＋幽靈列＋格狀態
4. 建議問法（會外形態：下次會議怎麼問）

**P2 — 教練進會議室**
5. Live 右欄缺口板（S11 gating＋live slotFills 暫態）
6. 預計時長欄（連結會議 dialog）＋下一步守門員
7. Talk-ratio per-stage＋過早報價偵測

**P3 — 品質判斷與資料驅動閉環**
8. SPIN 順序品質 eval＋階段錯位建議（會中）＋update-thread 階段推進（會後，#134）
9. Settings bundle 編輯器＋stage-bundles.json override
10. org playbook 共享（掛 D13 二輪）

## 9. 成功指標

- Discovery 會議結束時 I／N 兩格非空的比率（板自己可統計，對 Brandon 自己的案子）
- 「建議問法」的採用感（主觀：生成的句子敢不敢直接唸）
- 守門員觸發的會議中，會後 nextmove 卡帶日期的比率
- 警示噪音：每場 transient ≤3 則且 Brandon 沒有想關掉它（S10 的真正驗收）

## 10. 開放問題（review 時要拍的）

> 原問題 1（SPIN 用詞）、2（live 板形態）已於 2026-07-11 拍板 → S13、S14。

1. **薄/實門檻**：`solidAt=2`、過舊=30 天是拍腦袋值——用你的 AI3/喜來登卡片庫回放校準？
2. **預計時長的家**：掛在「這場會議」（本文提案，連結 dialog 設）vs 掛在 Thread（每場繼承）？
3. **builtin 文案定稿流程**：五階段 slot/hint 文案我先全部起草再一次 review，還是 discovery 先行其餘沿用舊指南？
4. **P1 順序**：本文提「作戰室先、live 後」（風險低、會前會後先有價值）；若要 live-first（開會當下最痛、且 S14 的 fill 體驗核心在 live），P1/P2 對調，成本是先碰 gating 與暫態路徑。
5. `spin-order` eval 的誤報容忍：info 級夠低調嗎，還是 P3 再上？

---

## 附錄 A：與現有機制的對應表（實作時的 reuse 清單）

| 本文概念 | 騎在誰身上 |
|----------|-----------|
| 教練規則注入/移除 | `buildRedlineEvals` 的 `stagecoach:` 前綴翻版（`redline.ts` 模式） |
| 空檔偵測、獨白、sustained-condition | `delivery.ts` LiveDeliveryMonitor（含校準與 steamroll 門檻） |
| 建議問法輸出形態與 UI | `SolutionReply`／`FindingSolution` cache pattern |
| live 板抽取節奏 | `runIntelExtraction` 全文重算模式＋schema 增列 |
| bundle 儲存/編輯模型 | `EvalTemplate` builtin+user 模式；config-dir JSON |
| 板的卡片 affordance 與新卡 highlight | ClaimCard／recentIngest（#143） |
| 階段文案資產 | i18n `accounts.stageGuide.*`（zh/en 已備） |
| 下一步守門員的「有日期下一步」判定 | 情報板 sales schema 的 commitments＋nextmove 提案 |
