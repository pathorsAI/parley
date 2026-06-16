import type { TodoTemplate } from "./types";

/** Built-in TODO/agenda templates. The user can apply, edit, or add their own. */
export const PRESET_TODO_TEMPLATES: TodoTemplate[] = [
  {
    id: "todo-sales-discovery",
    name: "Sales discovery",
    builtin: true,
    items: [
      "確認對方的角色與決策權",
      "了解現況與目前做法",
      "挖掘核心痛點與其影響",
      "量化痛點的成本／損失",
      "確認預算範圍",
      "釐清決策流程與關鍵人",
      "了解時程與急迫性",
      "詢問現有方案／競品",
      "約定明確的下一步",
    ],
  },
  {
    id: "todo-coffee-chat",
    name: "Coffee chat（創業前輩）",
    builtin: true,
    items: [
      "簡短自我介紹與來意",
      "請教對方的創業歷程與關鍵轉折",
      "請教他們現階段最大的挑戰",
      "針對我目前的方向請教看法",
      "請教常見的坑與建議",
      "詢問值得認識的人／引薦",
      "請教推薦的資源或書",
      "約定下次 follow-up 的方式",
    ],
  },
  {
    id: "todo-interview",
    name: "面試候選人",
    builtin: true,
    items: [
      "自我介紹與職缺說明",
      "請候選人介紹背景與動機",
      "深入追問一個代表性專案",
      "驗證核心技術／能力",
      "詢問過去的衝突與處理方式",
      "保留候選人提問時間",
      "確認薪資期待與可到職時間",
      "說明後續流程與時程",
    ],
  },
  {
    id: "todo-fundraising",
    name: "投資人 pitch",
    builtin: true,
    items: [
      "一句話講清楚在做什麼",
      "說明問題與市場規模",
      "Demo 產品",
      "商業模式與關鍵數據（traction）",
      "介紹團隊與為何是我們",
      "競爭與護城河",
      "募資金額與資金用途",
      "確認對方的投資範圍與決策流程",
    ],
  },
];
