import type { TodoTemplate } from "./types";
import type { TranslationKey } from "../i18n/messages";

/** A translate function bound to the current language: `(key) => string`. */
type T = (key: TranslationKey) => string;

/**
 * Built-in TODO/agenda templates. The first five mirror Parley's core
 * use-cases (job interviews, salary negotiations, sales calls, deal-making,
 * diligence calls); the rest are extra starting points. Users can apply,
 * edit, or add their own.
 *
 * Names and items are looked up through i18n (items are stored as a single
 * newline-joined string per template) so built-in templates follow the UI
 * language.
 */
export function buildPresetTodoTemplates(t: T): TodoTemplate[] {
  return [
    {
      id: "todo-interview",
      name: t("tpl.todo.todo-interview.name"),
      builtin: true,
      items: t("tpl.todo.todo-interview.items").split("\n"),
    },
    {
      id: "todo-salary",
      name: t("tpl.todo.todo-salary.name"),
      builtin: true,
      items: t("tpl.todo.todo-salary.items").split("\n"),
    },
    {
      id: "todo-sales-discovery",
      name: t("tpl.todo.todo-sales-discovery.name"),
      builtin: true,
      items: t("tpl.todo.todo-sales-discovery.items").split("\n"),
    },
    {
      id: "todo-deal",
      name: t("tpl.todo.todo-deal.name"),
      builtin: true,
      items: t("tpl.todo.todo-deal.items").split("\n"),
    },
    {
      id: "todo-diligence",
      name: t("tpl.todo.todo-diligence.name"),
      builtin: true,
      items: t("tpl.todo.todo-diligence.items").split("\n"),
    },
    {
      id: "todo-coffee-chat",
      name: t("tpl.todo.todo-coffee-chat.name"),
      builtin: true,
      items: t("tpl.todo.todo-coffee-chat.items").split("\n"),
    },
    {
      id: "todo-fundraising",
      name: t("tpl.todo.todo-fundraising.name"),
      builtin: true,
      items: t("tpl.todo.todo-fundraising.items").split("\n"),
    },
  ];
}
