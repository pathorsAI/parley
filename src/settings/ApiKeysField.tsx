import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { CopyButton } from "../components/CopyButton";
import { useI18n } from "../i18n";
import { log } from "../lib/log";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKey } from "../lib/cloud/apiKeys";
import { Field } from "./fields";

const DOCS_URL = "https://github.com/pathorsAI/parley/blob/main/docs/api.md";

/**
 * Settings › Account › API keys: mint a key for a server that reads this
 * account's synced recordings, see when each was last used, revoke one. A new
 * key's secret is shown once, right here, and never again.
 */
export function ApiKeysField() {
  const { t, language } = useI18n();
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<{ id: string; secret: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const refresh = useCallback(async () => {
    try {
      setKeys(await listApiKeys());
    } catch (error) {
      log.warn("settings: list api keys failed", { error: String(error) });
      setKeys([]);
    }
  }, []);
  useEffect(() => {
    refresh().catch((error) => log.warn("settings: api keys refresh failed", { error: String(error) }));
  }, [refresh]);

  const date = (ms: number) => new Date(ms).toLocaleDateString(language, { year: "numeric", month: "short", day: "numeric" });

  const create = async () => {
    setBusy(true);
    try {
      const { key, secret } = await createApiKey(name);
      setFresh({ id: key.id, secret });
      setName("");
      await refresh();
    } catch (error) {
      log.error("settings: create api key failed", { error: String(error) });
      toast.error(t("settings.apiKeys.createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    setRevoking(null);
    try {
      await revokeApiKey(key.id);
      if (fresh?.id === key.id) setFresh(null);
      await refresh();
    } catch (error) {
      log.error("settings: revoke api key failed", { error: String(error) });
      toast.error(t("settings.apiKeys.revokeFailed"));
    }
  };

  return (
    <Field label={t("settings.apiKeys.title")}>
      <div className="flex max-w-md flex-col gap-3 rounded-lg border p-3">
        <p className="text-[11px] text-muted-foreground">
          {t("settings.apiKeys.desc")}{" "}
          <a className="underline underline-offset-2" href={DOCS_URL} target="_blank" rel="noreferrer">
            {t("settings.apiKeys.docs")}
          </a>
        </p>

        {fresh && (
          <div className="flex flex-col gap-1.5 rounded-md bg-secondary p-2.5">
            <p className="text-[11px] font-medium">{t("settings.apiKeys.shownOnce")}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{fresh.secret}</code>
              <CopyButton value={fresh.secret} label={t("settings.apiKeys.copy")} />
            </div>
          </div>
        )}

        <KeyList keys={keys} date={date} onRevoke={setRevoking} />

        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && !busy) void create();
          }}
        >
          <Input
            className="h-8 text-xs"
            value={name}
            maxLength={60}
            placeholder={t("settings.apiKeys.namePlaceholder")}
            aria-label={t("settings.apiKeys.namePlaceholder")}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" size="sm" className="h-8 shrink-0 text-xs" disabled={!name.trim() || busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : t("settings.apiKeys.create")}
          </Button>
        </form>
      </div>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("settings.apiKeys.revoke")}</AlertDialogTitle>
          <AlertDialogDescription>{t("settings.apiKeys.revokeConfirm", { name: revoking?.name ?? "" })}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings.account.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => revoking && void revoke(revoking)}>
              {t("settings.apiKeys.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Field>
  );
}

function KeyList({
  keys,
  date,
  onRevoke,
}: Readonly<{ keys: ApiKey[] | null; date: (ms: number) => string; onRevoke: (key: ApiKey) => void }>) {
  const { t } = useI18n();
  if (keys === null) return <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  if (keys.length === 0) return <p className="text-[11px] text-muted-foreground">{t("settings.apiKeys.empty")}</p>;
  return (
    <ul className="flex flex-col divide-y">
      {keys.map((k) => (
        <li key={k.id} className="flex items-center gap-2 py-1.5">
          <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm">{k.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">
              <span className="font-mono">{k.prefix}…</span>
              {" · "}
              {t("settings.apiKeys.created", { date: date(k.createdAt) })}
              {" · "}
              {k.lastUsedAt ? t("settings.apiKeys.lastUsed", { date: date(k.lastUsedAt) }) : t("settings.apiKeys.neverUsed")}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            className="shrink-0 text-muted-foreground hover:text-destructive"
            title={t("settings.apiKeys.revoke")}
            aria-label={t("settings.apiKeys.revoke")}
            onClick={() => onRevoke(k)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  );
}
