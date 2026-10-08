// GENERATED from shared/prompts/study.json by scripts/gen-study-prompt.mjs — do not edit.
package com.pathors.parley.kit

/**
 * The shared study-pipeline prompts and evaluation presets. See shared/prompts/study.json.
 * `{{name}}` marks a placeholder ([StudyPromptBuilder.fill] fills them in one pass).
 */
object StudyPrompts {
    /** One built-in evaluation: what to watch for, and its name in each UI language. */
    data class Eval(val id: String, val prompt: String, val nameZhTw: String, val nameEn: String)

    const val MODEL_MEETING_KIND: String = "parley-fast"
    const val MODEL_FINDINGS: String = "parley-smart"
    const val MODEL_ACTION_ITEMS: String = "parley-smart"
    const val MODEL_BRIEF: String = "parley-smart"
    const val MODEL_DELIVERY: String = "parley-fast"

    const val TIMEOUT_SECONDS_MEETING_KIND: Int = 120
    const val TIMEOUT_SECONDS_FINDINGS: Int = 240
    const val TIMEOUT_SECONDS_ACTION_ITEMS: Int = 120
    const val TIMEOUT_SECONDS_BRIEF: Int = 240
    const val TIMEOUT_SECONDS_DELIVERY: Int = 120

    const val SCHEMA_PREFIX: String = "\n\nThis request carries no schema, so here is the shape the JSON object must have — reply with that one object and nothing else (no preamble, no code fences), property names verbatim:\n"
    const val SCHEMA_MEETING_KIND: String = "{\"kind\": \"internal\" | \"sales\" | \"pricing\" | \"rivalry\"}"
    /** Keyed by lens: decision, opportunity, adversarial. */
    val SCHEMA_TIMELINE: Map<String, String> = mapOf(
        "decision" to "{\"moments\": [{\"time\": \"[m:ss]\", \"category\": \"decision\" | \"open\" | \"fact\", \"severity\": \"info\" | \"warn\" | \"critical\", \"source\": \"eval\" | \"extra\", \"evalIds\": [string], \"title\": string, \"detail\": string}]}",
        "opportunity" to "{\"moments\": [{\"time\": \"[m:ss]\", \"side\": \"me\" | \"them\", \"severity\": \"info\" | \"warn\" | \"critical\", \"source\": \"eval\" | \"extra\", \"evalIds\": [string], \"title\": string, \"detail\": string}]}",
        "adversarial" to "{\"moments\": [{\"time\": \"[m:ss]\", \"side\": \"me\" | \"them\", \"severity\": \"info\" | \"warn\" | \"critical\", \"source\": \"eval\" | \"extra\", \"evalIds\": [string], \"title\": string, \"detail\": string, \"resolved\": boolean, \"resolution\": string}]}",
    )
    const val SCHEMA_ACTION_ITEMS: String = "{\"actions\": [{\"text\": string, \"linkedEventId\": string | null, \"time\": \"[m:ss]\" | null}]}"
    const val SCHEMA_DELIVERY: String = "{\"tone\": \"neutral\" | \"warm\" | \"firm\" | \"sharp\" | \"aggressive\" | \"rude\", \"tone_evidence\": string, \"filler_level\": \"ok\" | \"frequent\", \"filler_examples\": [string], \"filler_note\": string, \"pace\": \"slow\" | \"comfortable\" | \"fast\", \"summary\": string}\n- tone: the overall tone of the USER'S OWN contributions, not the other party's.\n- tone_evidence: a short verbatim quote from the user's own words that shows the tone; \"\" if none.\n- filler_level: \"frequent\" ONLY when watchlist fillers are dense enough in a short stretch to distract; default \"ok\".\n- filler_examples: the tics the user actually overused; [] when \"ok\".\n- filler_note: one short line about the over-frequent stretch; \"\" when \"ok\".\n- pace: how fast the user speaks overall.\n- summary: one short plain-language line on how the user comes across."

    const val JSON_MODE_INSTRUCTION: String = "\n\nReturn your answer strictly as a single JSON object matching the provided schema. Use the schema's property names EXACTLY (verbatim) — do not rename, translate, or add top-level keys."
    const val OUTPUT_LANGUAGE_TEMPLATE: String = "\n\nWrite ALL of your prose output (summaries, titles, explanations, advice) in {{language}}, regardless of the language spoken in the transcript. Keep any VERBATIM quotes you cite from the transcript in their original language."
    const val OUTPUT_LANGUAGE_NAME_ZH_TW: String = "Traditional Chinese (繁體中文)"
    const val OUTPUT_LANGUAGE_NAME_EN: String = "English"
    const val MEETING_CONTEXT_PREFIX: String = "Meeting context: "
    const val NO_SPEECH: String = "(no speech was captured)"

    const val MEETING_KIND_SYSTEM: String = "Classify a finished meeting transcript into EXACTLY ONE kind, so the right analysis can be run over it. Answer with the kind alone.\n\n- \"internal\": a working meeting among people ON THE SAME SIDE — a team discussion, design/product review, planning or roadmap session, project sync, retro, 1:1. Nobody is selling to anybody; the output is decisions and follow-ups. This is also where a meeting that fits NONE of the others belongs.\n- \"sales\": ME is selling to, or qualifying, a prospect or customer — discovery, demo, solution pitch, follow-up call. The other party is evaluating whether to buy. Commercial terms may come up, but the call is still about fit and value.\n- \"pricing\": the deal is already wanted by both sides and the conversation is about TERMS — price, discount, scope, payment, contract clauses, renewal. Concrete numbers are being pushed back and forth.\n- \"rivalry\": ME is across the table from a competitor, a rival, or a party whose interests genuinely conflict — carving up a market, a partnership between competitors, a dispute, a hard procurement standoff. Information leakage and non-committal wording matter more than closing.\n\nJudge the WHOLE conversation by what it was FOR, not by isolated words: one mention of a price inside a design review is still \"internal\", and a hard-fought discount conversation with an existing customer is \"pricing\", not \"sales\". When a sales call is genuinely dominated by haggling terms, prefer \"pricing\"; when you are torn between \"internal\" and anything else and the participants are plainly colleagues, choose \"internal\"."
    const val MEETING_KIND_TRANSCRIPT_HEADER: String = "Transcript:"

    const val TIMELINE_SYSTEM_TEMPLATE: String = "{{intro}}\n\nYou are given the user's ACTIVE EVALUATIONS (each with an id, a name, and what to look for) and the full timestamped transcript (every line is prefixed with its [m:ss] start time).\n\n{{selectionRule}}\n\nFor EACH moment provide:\n- time: the [m:ss] it is best anchored to — copy a REAL timestamp EXACTLY from the transcript line it refers to. This is the ONLY anchor (there are no quotes), so it must be accurate enough for ME to jump straight to that line.\n{{fieldGuide}}\n{{severityRule}}\n- source: \"eval\" when the moment matches one OR MORE configured evaluations — also set evalIds to EVERY eval id it genuinely matches. A single moment can match SEVERAL. Do NOT force-fit: if it doesn't clearly fit any eval, use \"extra\" with evalIds [].\n- evalIds: the matching evaluation ids (array — one, several, or [] for \"extra\").{{resolvedFields}}\n\nINTERPRET IN FULL CONTEXT — accuracy matters more than coverage:{{interpretation}}{{resolvedBlock}}\n\nBe selective and ACCURATE. A short list of well-judged findings is far better than many literal ones. Ground everything in what was actually said; never fabricate timestamps — every time must be copied from a real transcript line.{{modeBlock}}"
    const val TIMELINE_TENSE_REPLAY: String = "The conversation is OVER and you can see the whole thing."
    /** Keyed by lens: decision, opportunity, adversarial. */
    val TIMELINE_INTRO: Map<String, String> = mapOf(
        "decision" to "You are writing the RECORD of a working meeting — an internal team discussion, design review, planning session, or project sync — for the user (\"ME\"), who was in the room. {{tense}} Everyone present is on the SAME side; there is no opposing party and nothing to win. Your job is to capture what the meeting PRODUCED: what got decided, what is still open, and the facts established along the way.",
        "opportunity" to "You are analyzing a SALES conversation for the user (\"ME\") with a prospect or customer (\"THEM\"). {{tense}} This is not a fight to win — a customer objection is information, not an attack. Your job is to surface what moves the opportunity: the pain THEM revealed, the objections and risks THEM raised, and what ME still does not know.",
        "adversarial" to "You are doing a post-hoc RETRO of a finished negotiation for the user (\"ME\") against the other party (\"THEM\"). {{tense}}",
    )
    /** Keyed by lens: decision, opportunity, adversarial. */
    val TIMELINE_SELECTION_RULE: Map<String, String> = mapOf(
        "decision" to "Work at the level of MEANINGFUL EXCHANGES, not individual sentences. Read the meeting, then surface the handful of moments that carry what it produced — a decision reached, a question left open, a substantive fact established. GROUP a back-and-forth on one topic into ONE moment, anchored at its most representative timestamp; when a topic was argued and then settled, that is ONE \"decision\" moment at the point it was settled, never one finding per turn. Prefer a few high-signal entries over many granular ones, and make sure every real DECISION is captured before you spend slots on facts.",
        "opportunity" to "Work at the level of MEANINGFUL EXCHANGES, not individual sentences. Read the call, then surface the handful of moments that actually move the opportunity — a pain THEM described, a requirement or constraint, an objection or concern, a competitor or alternative, a buying signal, or a qualification gap on MY side. GROUP a back-and-forth on one topic into ONE moment. Prefer a few high-signal findings over many granular ones.",
        "adversarial" to "Work at the level of MEANINGFUL EXCHANGES, not individual sentences. Read the conversation, then surface only the handful of moments that genuinely shaped the negotiation — a position taken, leverage, a constraint or concern raised, a concession, a real risk, a mistake/missed move by ME, OR a real challenge/objection/pressure/risk from THEM that ME meaningfully handled (a WIN worth recording — surface it as a resolved moment; see RESOLVED MOMENTS). A win counts ONLY when there was genuine tension for ME to defuse AND ME actually reduced the risk — never ME merely replying, answering a neutral question, being agreeable, or saying something pleasant. GROUP a back-and-forth on one topic into ONE moment, anchored at its most representative timestamp; do NOT emit a separate finding for each sentence or minor turn — a mistake by ME and ME's own later meaningful repair are ONE resolved moment, never two. Prefer a few high-signal findings over many granular ones, and surface open/unresolved problems and risks FIRST: wins are ADDITIONAL, never a substitute for an open problem and never take its slot.",
    )
    /** Keyed by lens: decision, opportunity, adversarial. */
    val TIMELINE_FIELD_GUIDE: Map<String, String> = mapOf(
        "decision" to "- category: \"decision\" when the meeting SETTLED something (a choice made, an approach agreed, a thing explicitly dropped) — this is the most valuable output, do not bury a real decision as a mere fact; \"open\" when a question was raised and left UNRESOLVED, or a decision was explicitly deferred; \"fact\" for a substantive piece of information established or explained that is neither.\n- title: a short label for what was decided / left open / established.\n- detail: ONE or two sentences carrying the substance — for a decision, WHAT was decided and, when it was argued, the reason that won; for an open item, what specifically is still undecided and what it is blocked on.\nDo NOT judge how well ME performed, do NOT score anyone, and do NOT write coaching advice. This is a record, not a review.",
        "opportunity" to "- side: \"them\" for something THEM revealed or raised (a pain, a requirement, an objection, a constraint, a buying signal, a competitor); \"me\" for a gap on MY side — a question ME failed to ask, a qualification dimension still unknown, a commitment ME made loosely.\n- title: a short label for the moment.\n- detail: 1-2 sentences on what it means for the opportunity — what the pain really is, what is behind the objection, or what ME still needs to learn.\nDo NOT frame THEM as an adversary and do NOT score ME on \"winning\" an exchange. An objection ME answered is still worth recording as the objection it was.",
        "adversarial" to "- side: \"them\" for a substantive move BY THEM (a position, argument, demand, anchor, pressure, leverage, or a constraint/concern they raised); \"me\" for a problem/mistake/missed move BY ME.\n- title: a short label for the dynamic (not a quote).\n- detail: 1-2 sentences on the STRATEGIC substance — the underlying interest, leverage, risk, missed exploration, or move — and why it matters.",
    )
    /** Keyed by lens: decision, opportunity, adversarial. */
    val TIMELINE_SEVERITY_RULE: Map<String, String> = mapOf(
        "decision" to "- severity: how much this matters to the work — \"critical\" for a decision or open question that blocks or redirects real effort, \"warn\" for one that will bite if forgotten, \"info\" for the rest. This is NOT a judgement of anyone's performance.",
        "opportunity" to "- severity: how much this bears on whether the deal happens — \"critical\" for a blocking objection or an unknown that could kill it, \"warn\" for a real risk or gap, \"info\" for useful colour.",
        "adversarial" to "- severity: info / warn / critical. For a resolved win, judge severity by the STAKES the challenge would have had IF UNHANDLED — a resolved finding already renders GREEN, so do not wash it down to \"info\".",
    )
    /** Keyed by lens: decision, opportunity, adversarial. */
    val TIMELINE_INTERPRETATION: Map<String, String> = mapOf(
        "decision" to "\n- There is no opposing party here. Never frame one participant against another, never judge who \"won\" an exchange, and never assess how well ME argued. If the meeting disagreed and then converged, record the CONCLUSION and (briefly) the reason that carried it, not the contest.\n- A decision must actually have been SETTLED in the room. \"We should probably do X\" with no agreement is \"open\", not \"decision\" — do not promote a stray suggestion into a decision, and do not invent one when the meeting genuinely settled nothing.\n- Explicitly dropping or deferring something IS a decision; record it as one.\n- A question someone asked and nobody answered is \"open\" even if the conversation moved on. Those are the entries the meeting notes exist for.",
        "opportunity" to "\n- An objection is INFORMATION, not an attack, and ME answering one does not make it disappear — record the objection itself so ME can see what THEM actually worries about.\n- A neutral QUESTION from THEM is not pressure and not a buying signal; do not inflate it into either.\n- Distinguish a stated problem from a QUANTIFIED one. \"Our current process is slow\" is a lead, not a pain — flag that it was never sized (cost, hours, risk, a compelling event).\n- Be honest about qualification gaps on MY side: budget, decision process, who actually signs, the competing option, the timeline. An unasked question is a finding.",
        "adversarial" to "\n- A neutral QUESTION or request from either side is NOT a claim, assertion, or pressure; never label it as one. Asking is not claiming.\n- Do NOT mislabel a legitimate CONSTRAINT, concern, or honest disclosure as deception or inconsistency. Someone explaining a genuine conflict (e.g. \"if I sign this as-is I'd breach a prior commitment\") or changing approach for a stated reason is raising something to SOLVE — flag deception/inconsistency ONLY when the transcript genuinely shows a contradiction or misrepresentation in context.\n- When THEM makes a strong point or a good proposal, surface it as a \"them\" moment so ME can think about how to respond — even if no eval targets it.\n- If MY negotiation setup (BATNA / target / bottom line) is provided in the context, USE it: judge leverage and the ZOPA (zone of possible agreement) against it, separate interests from positions, prefer objective criteria over pressure, and flag when ME is being pushed toward MY bottom line.",
    )
    const val TIMELINE_RESOLVED_FIELDS: String = "\n- resolved: true ONLY when ME meaningfully mitigated / repaired this moment — explored the concern, protected leverage, traded for value, corrected MY own misstep, or otherwise reduced the risk. false if ME merely replied, gave an unexplored concession, accepted the premise, left it hanging, ignored it, or you are unsure. (Mainly a \"them\" pressure/objection/risk that ME handled well enough to reduce, but also a \"me\" misstep ME later fixed.)\n- resolution: when resolved, ONE short line naming MY actual move and quoting/paraphrasing MY key words; \"\" when not resolved."
    const val TIMELINE_RESOLVED_BLOCK: String = "\n\nRESOLVED MOMENTS — record what ME meaningfully handled, do NOT drop it. A real challenge ME reduced is a WIN worth showing precisely BECAUSE handling it is what ME should see; when ME later explores, counters with substance, trades for value, corrects, repairs, or defuses a moment, set resolved + resolution and it renders GREEN. Keep its side by WHOSE move it was, never by who came out ahead: a THEM objection/pressure/risk ME mitigated stays \"them\" + resolved; a ME misstep ME repaired stays \"me\" + resolved. Be strict — a reply alone is NOT resolution. Do NOT mark resolved when ME simply answered, changed the number/position, conceded, accepted pressure, or moved on without exploring the other side's interest/rationale. You MUST judge whether MY response meaningfully reduced the risk; if it did not, keep the underlying problem unresolved and set severity by its stakes. For example, if THEM says \"6000 is too high\" and ME immediately drops to 4500 without probing budget, criteria, priorities, or a trade, that is likely a serious unresolved ME concession/missed-exploration issue, NOT resolved. If you cannot name MY meaningful mitigating move in the resolution line, it is not resolved. In a still-in-progress meeting, mark resolved ONLY once ME has clearly finished a meaningful mitigation; a reply still unfolding stays unresolved. A moment ME ignored or never came back to stays unresolved."
    /** Keyed by lens: decision, opportunity, adversarial. */
    val TIMELINE_MODE_REPLAY: Map<String, String> = mapOf(
        "decision" to "\n\nMODE: FINISHED MEETING. You can see the whole thing, so a topic raised early and settled late is ONE decision recorded at the point it was settled, and a question nobody ever came back to is \"open\" no matter how early it was asked.",
        "opportunity" to "\n\nMODE: POST-CALL.\n- The call is over. Be direct about what ME failed to ask and which qualification dimensions are still blank — that is the most useful thing this pass produces.\n- An objection ME answered still belongs in the record as an objection; do not drop it because it was handled.",
        "adversarial" to "\n\nMODE: POST-EVALUATION / RETROSPECTIVE ANALYSIS.\n- The conversation is over. Be direct about what went wrong, where MY response was weak, what leverage or information ME failed to explore, and what ME should learn for next time.\n- You may use later counterparty behavior as hindsight evidence, but label it as hindsight in the detail when it matters (for example: \"In hindsight, their later budget comment suggests this should have been probed here.\").\n- Do not convert a bad response into a green/resolved card merely because ME replied; unresolved mistakes and weak concessions should stay warn/critical.",
    )
    const val TIMELINE_EVALS_HEADER: String = "Active evaluations:"
    const val TIMELINE_NO_EVALS: String = "(none configured)"
    const val TIMELINE_EVAL_ENTRY: String = "### id: {{id}}\nname: {{name}}\nwatch for: {{prompt}}"
    const val TIMELINE_TRANSCRIPT_LABEL_REPLAY: String = "Full transcript"

    const val ACTION_ITEMS_SYSTEM_TEMPLATE: String = "{{intro}}\n\nYou are given the FINDINGS from the analysis (notable moments, each with an id) and the full timestamped transcript. {{flavour}}\n- linkedEventId: the finding id it derives from when it maps to one, else null.\n- time: the [m:ss] it relates to (copy a real transcript timestamp), else null.\n\nBe selective — surface the actions that genuinely matter (typically 3-7), not busywork. Ground everything in what was actually said."
    /** Keyed by lens: decision, opportunity, adversarial. */
    val ACTION_ITEMS_INTRO: Map<String, String> = mapOf(
        "decision" to "You are writing the FOLLOW-UPS from a finished internal working meeting, for ME. The meeting is OVER. These are the things the meeting agreed someone would go do, plus anything left open that needs chasing.",
        "opportunity" to "You are writing the POST-CALL next steps after a finished sales conversation, for ME. The call is OVER.",
        "adversarial" to "You are writing the POST-MEETING ACTION ITEMS for the user (\"ME\") after a finished negotiation against the other party (\"THEM\"). The meeting is OVER.",
    )
    const val ACTION_ITEMS_FLAVOUR_DECISION: String = "Produce the follow-ups this meeting generated — things someone agreed to do, decisions that need writing up or communicating, and open questions that need chasing before the next session. For each action:\n- text: the concrete next step, phrased as an action. It must stand on its own — carry the WHAT into this line rather than leaving it to a separate \"why\" field, but keep it to one readable sentence."
    const val ACTION_ITEMS_FLAVOUR_DEFAULT: String = "Produce a short, concrete list of follow-up ACTIONS ME should take next — things to send, clarify, prepare, decide, or do differently next time. For each action:\n- text: the concrete next step, phrased as an action ME can do. It must stand on its own — carry the WHAT into this line rather than leaving it to a separate \"why\" field, but keep it to one readable sentence."
    const val ACTION_ITEMS_FINDINGS_HEADER: String = "Findings:"
    const val ACTION_ITEMS_NO_FINDINGS: String = "(no findings)"
    const val ACTION_ITEMS_FINDING_ENTRY: String = "### id: {{id}}\n[{{tag}}] {{title}}: {{detail}}"
    const val ACTION_ITEMS_FINDING_TAG_FALLBACK: String = "note"
    const val ACTION_ITEMS_TRANSCRIPT_HEADER: String = "Full transcript:"

    const val BRIEF_SYSTEM_TEMPLATE: String = "{{intro}}\n\nWrite it in Markdown with exactly these sections:\n\n{{sections}}\n\nEach transcript line is prefixed with its [m:ss] start time. Cite those timestamps verbatim whenever you point at a specific moment so the reader can jump back to it. Ground everything in what was actually said. Skip filler and praise that isn't earned. If the transcript is too short to assess, say so plainly."
    /** Keyed by lens: decision, opportunity, adversarial. */
    val BRIEF_INTRO: Map<String, String> = mapOf(
        "decision" to "You are writing the MEETING NOTES for a finished internal working meeting, for ME, who was in the room. Everyone present was on the same side. The meeting is OVER and you can see the full transcript.",
        "opportunity" to "You are writing the POST-CALL summary of a finished SALES conversation for ME. The call is OVER and you can see the full transcript, so judge the whole conversation, not the moment.",
        "adversarial" to "You are writing a POST-MEETING debrief for ME after a live negotiation. The meeting is OVER and you can see the full transcript, so judge the whole conversation, not the moment.",
    )
    /** Keyed by lens: decision, opportunity, adversarial. */
    val BRIEF_SECTIONS: Map<String, String> = mapOf(
        "decision" to "## Highlights\n3-5 bullets covering what this meeting was actually about and what came out of it. No praise, no scoring.\n\n## Decisions\nEvery decision the meeting settled — one bullet each, stating what was decided. End each bullet with the [m:ss] where it was settled. If the meeting settled nothing, say so in one line rather than inventing decisions.\n\n## Open questions\nWhat was raised and left unresolved, and what each one is waiting on. End each bullet with its [m:ss].\n\n## Suggested next agenda\n2-4 bullets: what the next session of this meeting should open with, based on what was left open.\n\nWrite a RECORD, not a review. Do NOT assess how ME performed, do NOT list what fell short, and do NOT give coaching advice — none of that belongs in meeting notes.",
        "opportunity" to "## Where this landed\nHow the opportunity stands after this call, in a few lines.\n\n## Their pain and objections\nWhat THEM actually needs, and every concern or objection they raised — each with a [m:ss].\n\n## What we still don't know\nThe qualification gaps that matter: unknown budget, decision process, timeline, competing options, who actually decides. Be specific about the question that would close each gap.\n\n## Next steps\nWhat ME should do to advance this deal, concretely.",
        "adversarial" to "## Outcome\nHow it went overall and whether ME achieved the goal.\n\n## What fell short\nObjectives or evaluation criteria that were NOT met — each with a one-line piece of evidence from the transcript.\n\n## How to improve\nConcrete, specific things ME could do better next time. No generic advice.\n\n## Key moments\n2-4 pivotal points. Start each bullet with the moment's timestamp in [m:ss] form (copy it from the transcript line), then: what happened, then the counterfactual — \"when X happened, if ME had done Y, THEM could not have Z.\"",
    )
    const val BRIEF_RUBRIC_HEADER: String = "What mattered in this meeting (evaluation rubric):"
    const val BRIEF_RUBRIC_ENTRY: String = "- {{name}}: {{prompt}}"
    const val BRIEF_CHECKLIST_HEADER: String = "Agenda / checklist:"
    const val BRIEF_CHECKLIST_ENTRY: String = "- [{{mark}}] {{text}}"
    const val BRIEF_TRANSCRIPT_HEADER: String = "Full transcript:"

    const val DELIVERY_SYSTEM_TEMPLATE: String = "You are a delivery coach for the user in a {{setting}}. Judge the USER'S OWN delivery only — never the other party's; use the profile to tell which speaker is the user. Two things:\n1) TONE — reserve 'aggressive'/'rude' for genuinely hostile, demeaning, dismissive, or contemptuous wording; firm disagreement or pushback is 'firm', not aggressive. When uncertain, prefer the milder label.\n2) FILLER WORDS / VERBAL CRUTCHES — consider ONLY the lexical words/phrases in the provided watchlist. Do NOT consider non-lexical hesitation sounds (um, uh, er, 呃, 啊, 嗯) — speech-to-text usually drops them, so they won't be in the transcript. Filler use is normal and human: flag 'frequent' ONLY when the user leans on watchlist words as crutches densely enough to distract a listener; never flag ordinary, meaningful uses of those same words, and never flag mere presence.\nBe honest and concise."
    const val DELIVERY_SETTING_POST: String = "just-finished conversation"
    const val DELIVERY_MEASURED_RATE_TEMPLATE: String = "Acoustically measured speaking rate for this session: ~{{rate}} syllables/sec (≈ {{perMinute}} syllables/min). Use this for the pace read rather than guessing from the text.\n\n"
    const val DELIVERY_WATCHLIST_TEMPLATE: String = "Filler watchlist (judge OVER-use of these as verbal crutches only — ignore meaningful uses, and ignore non-lexical um/uh sounds): {{words}}\n\n"
    const val DELIVERY_TRANSCRIPT_LABEL_POST: String = "Full transcript"

    val FILLER_WORDS_ZH_TW: List<String> = listOf(
        "那個",
        "這個",
        "就是",
        "就是說",
        "然後",
        "反正",
        "其實",
        "基本上",
        "怎麼講",
        "怎麼說",
        "你知道",
        "你知道嗎",
        "你懂嗎",
        "對不對",
        "對啊對啊",
        "這樣子",
        "之類的",
        "什麼的",
        "老實說",
        "說真的",
        "的部分",
        "的話",
    )
    val FILLER_WORDS_EN: List<String> = listOf(
        "like",
        "you know",
        "i mean",
        "basically",
        "actually",
        "literally",
        "sort of",
        "kind of",
        "kinda",
        "sorta",
        "you see",
        "i guess",
        "right?",
        "so yeah",
        "to be honest",
        "at the end of the day",
        "or whatever",
        "and stuff",
    )

    /** Meeting kind → the lens its findings and brief are written in. */
    val KIND_LENS: Map<String, String> = mapOf(
        "internal" to "decision",
        "sales" to "opportunity",
        "pricing" to "adversarial",
        "rivalry" to "adversarial",
    )

    /** Meeting kind → the built-in evaluation template it watches with. */
    val KIND_TEMPLATE: Map<String, String> = mapOf(
        "internal" to "tpl-internal",
        "sales" to "tpl-sales",
        "pricing" to "tpl-pricing",
        "rivalry" to "tpl-rivalry",
    )

    val CORE_EVALS: List<String> = listOf(
        "deception",
        "inconsistency",
        "pushback",
        "unanswered",
        "checklist",
        "claims",
        "topic-shift",
        "leverage",
    )

    /** Template id → its evaluation ids, in order. */
    val TEMPLATES: Map<String, List<String>> = mapOf(
        "tpl-internal" to listOf("in-undecided", "in-unowned", "in-scope", "in-blocked", "unanswered", "checklist"),
        "tpl-sales" to listOf("sl-qualification", "sl-pain", "sl-objections", "claims", "unanswered", "nextmove"),
        "tpl-pricing" to listOf("zopa", "batna", "criteria", "ng-concessions", "pushback", "leverage", "deception", "nextmove"),
        "tpl-rivalry" to listOf("rv-leak", "rv-probing", "rv-commitment", "batna", "deception", "inconsistency", "pushback", "topic-shift"),
    )

    val EVALS: List<Eval> = listOf(
        Eval(
            id = "deception",
            prompt = "You are monitoring the OTHER party ('them') for active DECEPTION or MANIPULATION (bad-faith tactics) — NOT mere inconsistency. Look for: evasive non-answers, bluffing, unverifiable grand claims, moving the goalposts, manufactured/false urgency, or pressure tactics meant to mislead or coerce. A legitimate constraint, an honest 'I don't know', or a stated change of position for a real reason is NOT deception. Flag only with concrete textual evidence; quote the suspicious lines.",
            nameZhTw = "詐術偵測",
            nameEn = "Deception",
        ),
        Eval(
            id = "inconsistency",
            prompt = "Track whether the OTHER party ('them') CONTRADICTS THEMSELVES: a later statement that genuinely conflicts with something they said earlier — a number, commitment, timeline, position, or fact that changed WITHOUT a stated reason. Flag only a real contradiction and cite BOTH conflicting quotes with their timestamps. A stated change of position for a legitimate reason, or a constraint/concern they raise (e.g. 'if I sign this as-is I'd breach a prior commitment'), is NOT an inconsistency — do not flag it.",
            nameZhTw = "前後不一致",
            nameEn = "Inconsistency",
        ),
        Eval(
            id = "pushback",
            prompt = "Identify moments where I ('me') should push back. Pushing back is NOT only arguing a term — it also means calling out vague over-promising or grand 'big-picture' pitches with no specifics, and pressing when the other party blurs focus or paints a rosy picture to dodge a hard point. Look for: one-sided terms, unreasonable demands, assumptions stated as facts, concessions extracted from me without reciprocity, or hand-wavy promises I should pin down. Flag it and suggest specifically what to push back on or what concrete commitment to ask for.",
            nameZhTw = "適時反制",
            nameEn = "When to push back",
        ),
        Eval(
            id = "unanswered",
            prompt = "Track questions I ('me') asked that the other party did NOT clearly answer — they deflected, gave a vague response, or changed the subject. Flag each open question so I can re-ask it. Quote my original question and their evasive reply.",
            nameZhTw = "未回答的問題",
            nameEn = "Unanswered questions",
        ),
        Eval(
            id = "checklist",
            prompt = "Given the meeting context provided, identify important topics or questions that are standard for this kind of meeting but have NOT yet been covered. Flag what's missing so I can raise it before the meeting ends.",
            nameZhTw = "流程遺漏",
            nameEn = "Process gaps",
        ),
        Eval(
            id = "claims",
            prompt = "Extract concrete, verifiable factual claims made by the other party ('them') — numbers, dates, credentials, references, commitments. These are things worth fact-checking later. List each claim. Severity is informational unless a claim is central to the deal/decision.",
            nameZhTw = "待查證宣稱",
            nameEn = "Claims to verify",
        ),
        Eval(
            id = "topic-shift",
            prompt = "Watch for the other party ('them') steering away from the point: a sudden topic change, answering a different question than the one asked, retreating into vague generalities, or burying the issue under irrelevant detail — especially right after I ('me') raised something they'd rather avoid. When it happens, flag it, name the specific point they slid off, and suggest how I can steer back. This helps a less-experienced operator catch deflection in the moment.",
            nameZhTw = "話題偏移",
            nameEn = "Topic drift",
        ),
        Eval(
            id = "leverage",
            prompt = "Apply the principled-negotiation 'invent OPTIONS for mutual gain' principle: spot chances to EXPAND THE PIE rather than just split it — issues the two sides value DIFFERENTLY that can be traded, package deals, or contingent terms. Using the meeting context and MY stated target/direction, surface a concrete option ME can propose (what ME gives, what ME asks for in return) that moves toward MY goal while still being attractive to THEM — so ME negotiates on value, not just position.",
            nameZhTw = "創造價值的選項",
            nameEn = "Options for mutual gain",
        ),
        Eval(
            id = "in-undecided",
            prompt = "Watch for topics the room TREATED as settled without actually settling them: a proposal met with 'sure' or silence and never confirmed, two people agreeing to different things in the same breath, or a decision announced while an unanswered objection was still on the table. Flag each one and name the specific thing that still needs an explicit decision. A genuine, explicit agreement is NOT a finding.",
            nameZhTw = "假性共識",
            nameEn = "False consensus",
        ),
        Eval(
            id = "in-unowned",
            prompt = "Track work the meeting created and whether anyone actually took it. Flag every task, follow-up, or investigation that was agreed but left with NO named owner, no deadline, or an owner who never acknowledged it ('someone should…', 'we need to…'). Quote the line where the work appeared.",
            nameZhTw = "沒人認領的工作",
            nameEn = "Unowned work",
        ),
        Eval(
            id = "in-scope",
            prompt = "Watch for scope quietly growing: new requirements, extra cases, or 'while we're in there' additions folded into existing work without anyone weighing the cost or moving a date. Flag what was added and what it was added onto, so the trade-off gets made deliberately instead of by accident.",
            nameZhTw = "範圍悄悄長大",
            nameEn = "Scope creep",
        ),
        Eval(
            id = "in-blocked",
            prompt = "Surface dependencies and blockers named in the meeting: work waiting on another person, team, decision, or external party. Flag each with what is blocked and what it is waiting on. Also flag a blocker that was mentioned in passing and never assigned to anyone to unblock.",
            nameZhTw = "相依與卡點",
            nameEn = "Dependencies and blockers",
        ),
        Eval(
            id = "sl-qualification",
            prompt = "You are helping qualify a sales opportunity. Track the MEDDICC-style dimensions: quantified Metrics, Economic buyer, Decision criteria, Decision process, identified Pain, and a Champion. Flag which dimensions are still unknown or weak so I ('me') can ask about them before the call ends.",
            nameZhTw = "資格判定缺口 (MEDDICC)",
            nameEn = "Qualification gaps (MEDDICC)",
        ),
        Eval(
            id = "sl-pain",
            prompt = "Assess the prospect's pain. Flag when their problem is stated vaguely, is not quantified (cost, time, risk), or lacks urgency / a compelling event. Suggest the specific question that would deepen or quantify the pain.",
            nameZhTw = "痛點深度與急迫性",
            nameEn = "Pain depth & urgency",
        ),
        Eval(
            id = "sl-objections",
            prompt = "Detect objections or concerns the prospect ('them') raises — price, timing, fit, competitor, risk, authority. Flag each one, and especially any that I ('me') have NOT yet addressed. Quote the objection.",
            nameZhTw = "顧慮",
            nameEn = "Objections",
        ),
        Eval(
            id = "nextmove",
            prompt = "Based on the conversation so far, recommend the single best next move for me ('me') to advance my goal — the specific question to ask, point to make, or term/number to propose right now. Make it concrete and say it in words I could use, plus one short line on why now. Only surface a new suggestion when the situation has meaningfully moved.",
            nameZhTw = "下一步建議",
            nameEn = "Next move",
        ),
        Eval(
            id = "zopa",
            prompt = "Map the ZOPA (Zone Of Possible Agreement) on the key terms (price, scope, timing, equity, …): track what each side reveals about their acceptable range versus MY target and bottom line from the setup. Flag when an offer falls OUTSIDE the likely ZOPA, when the revealed ranges OVERLAP (a deal is reachable), or when a number is still missing to locate the zone. Be concrete about which term and the implied range.",
            nameZhTw = "成交區間（ZOPA）",
            nameEn = "Zone of agreement",
        ),
        Eval(
            id = "batna",
            prompt = "Track BATNA (Best Alternative To a Negotiated Agreement) — each side's walk-away option, the true source of leverage. Using MY BATNA and bottom line from the setup, flag: signals about THEM's alternatives (strong or weak), moments THEM tests or probes MY alternative, and when the conversation pushes ME toward MY bottom line. Note who currently holds the stronger BATNA and what it means for MY leverage.",
            nameZhTw = "BATNA（替代方案）",
            nameEn = "BATNA",
        ),
        Eval(
            id = "criteria",
            prompt = "Apply 'insist on OBJECTIVE CRITERIA'. Flag when a number or term is justified by will, pressure, or 'that's just our policy' rather than an objective standard (market rate, precedent, independent benchmark, a formula). Name the objective criterion ME could anchor to so the term is decided on merit, not power. Quote the unsupported claim.",
            nameZhTw = "客觀標準",
            nameEn = "Objective criteria",
        ),
        Eval(
            id = "ng-concessions",
            prompt = "Track concessions and commitments on both sides: what each party has offered, conceded, or agreed to. Flag asymmetric exchanges where I ('me') gave more than I received. Summarize the current state of the deal.",
            nameZhTw = "讓步追蹤",
            nameEn = "Concession tracking",
        ),
        Eval(
            id = "rv-leak",
            prompt = "Watch what MY side gives away. Flag every moment ME volunteered information a competitor could use: roadmap, pricing structure, margins, customer names, headcount, timelines, weaknesses, or how badly ME needs this deal. Note whether THEM gave anything comparable in return — a one-sided disclosure is the finding, even when it felt like rapport.",
            nameZhTw = "我方資訊外洩",
            nameEn = "What we gave away",
        ),
        Eval(
            id = "rv-probing",
            prompt = "Detect THEM probing for intelligence rather than negotiating: questions about MY costs, customers, capacity, other deals, or internal plans that go beyond what this agreement needs. Flag each probe and what it is really after, so ME can decide what to answer.",
            nameZhTw = "對方在套情報",
            nameEn = "They're fishing",
        ),
        Eval(
            id = "rv-commitment",
            prompt = "Track the SYMMETRY of commitments. Flag when ME commits to something concrete (a date, a number, an exclusivity, a restriction) while THEM stays deliberately vague — 'we'd look at it', 'in principle', 'subject to internal approval'. Name the specific commitment ME made and the vague answer it bought.",
            nameZhTw = "承諾不對等",
            nameEn = "Lopsided commitments",
        ),
    )
}
