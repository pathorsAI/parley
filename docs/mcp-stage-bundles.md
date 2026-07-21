# Stage-bundles MCP server — 用你的 Claude 編輯銷售 domain know-how

`mcp/stage-bundles-server.ts` 是一個 stdio MCP server（#155）：讓外部的 Claude（Claude Code / Claude Desktop）直接讀寫 Parley config 目錄的 `stage-bundles.json`——編輯內建六階段的板內容（S9 整階段覆寫），或**新增自訂 pipeline 階段**（例：把陌生開發 cold call 從「開發」拆出獨立階段）。

App 不需要開著；開著的話：live 情報板的 30 秒萃取迴圈每輪重讀檔案，開板／stepper 走 10 秒 TTL 快取——改動最慢半分鐘內生效。

## 註冊

```sh
# Claude Code
claude mcp add parley-bundles -- bun run /path/to/parley/mcp/stage-bundles-server.ts
```

環境變數：

| 變數 | 用途 | 預設 |
|---|---|---|
| `PARLEY_CONFIG_DIR` | 覆寫 config 目錄（測試用） | `~/Library/Application Support/com.pathors.parley` |
| `PARLEY_LANG` | 內建文案的呈現語言（`zh-TW`／`en`） | `zh-TW` |

## Tools

| Tool | 用途 |
|---|---|
| `list_stages` | pipeline 全序（內建＋自訂）、名稱、來源、是否被覆寫、slot 數 |
| `get_stage` | 單一階段的**有效** bundle（內建含覆寫；先看 shape 再改） |
| `upsert_stage_override` | 整階段覆寫（S9，無 per-slot merge）；內建與自訂皆可 |
| `remove_stage_override` | 移除覆寫，內建階段回出廠內容 |
| `add_custom_stage` | 新增自訂階段：`id`（小寫 slug、無點、不可撞內建）＋`name`＋`insertAfter`（插在哪一階之後，預設接尾）＋完整 bundle |
| `update_custom_stage` | 改自訂階段的 name／位置／bundle |
| `remove_custom_stage` | 移除自訂階段（連其覆寫一起；停在該階段的戰線在 live 板 fallback 到 pipeline 起點） |

## 資料紀律（驗證由 app 同一套 `bundleFile.ts` 執行）

- **slot id 必須帶階段前綴**（`coldcall.hook`）——slot 標籤與補分類 sentinel（`<stage>.none`）都以前綴判定歸屬（#146）
- bundle 的 `slots[].hint` 同時是幽靈列文案與萃取／聚焦／建議問法的語意提示——**know-how 寫在這裡就會進 prompt**
- 自訂階段的 `name`／`goal` 寫在 bundle 資料裡（不走 i18n key）
- 壞資料防禦性丟棄（單筆丟、不整檔丟），MCP 回應會附 warnings

## 例：新增陌生開發階段

```
add_custom_stage {
  "id": "coldcall", "name": "陌生開發", "insertAfter": "prospecting",
  "bundle": {
    "stage": "coldcall", "boardTitle": "陌生開發板",
    "goal": "30 秒內講清楚為什麼打來，換到一次回撥或直接聊",
    "slots": [
      { "id": "coldcall.hook", "label": "開場鉤子",
        "hint": "對方公司最近的事件/痛點切入，不是自我介紹",
        "query": { "categories": ["openq"] } }
    ],
    "exitCriteria": ["換到回撥時間或直接進開發對話"],
    "coachRules": []
  }
}
```

## 情境(Scenarios,v3)

情境系統之後,`stage-bundles.json` 升到 **v3**:銷售只是內建情境之一(五階段),談判/合作是單階段內建情境(stage id `nego`/`partner`,可用 `upsert_stage_override` 覆寫),而你可以**新增整個自訂情境**(例:面試、募資簡報)。v1/v2 檔案照常解析。

新工具:

| 工具 | 用途 |
|---|---|
| `list_scenarios` | 列出內建+自訂情境與各自的階段 |
| `upsert_scenario` | 建立/整包替換一個自訂情境:`{id, name, icon?, guidance?, evalTemplateId?, stages:[{id,name,bundle}]}`。單階段情境在 UI 不顯示階段列;`guidance` 是餵給抽取模型的英文開場;`evalTemplateId` 讓選情境時自動套教練模板 |
| `remove_scenario` | 刪除自訂情境(連同其階段的 overrides) |

規則:情境 id 與階段 id 都是小寫 slug、不可撞內建;slot id 必須以 `<stageId>.` 開頭;階段 id 全域唯一(claims 以 slot id 掛卡)。
