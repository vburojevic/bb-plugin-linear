import { useCallback, useEffect, useState } from "react";
import { useBbNavigate } from "@bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAsync, useLinearRpc } from "./rpc.js";

/**
 * Capture, not composition.
 *
 * Two fields — a title, and a description for whoever has one ready — because
 * the moment this dialog serves is "get the thought into the tracker before
 * it evaporates". Everything else an issue can carry is one click away in the
 * detail pane this lands in, where each property gets a real editor instead
 * of a cramped dialog row. A create form with nine fields is a form that
 * loses the race against a sticky note.
 *
 * The team select renders only when there is a choice to make. Most installs
 * bind one team; showing a picker with one option is asking a question whose
 * answer is known.
 */
export function NewIssueButton({ currentTeamId }: { currentTeamId: string | null }) {
  const rpc = useLinearRpc();
  const navigate = useBbNavigate();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [teamId, setTeamId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const targets = useAsync(
    useCallback(async () => rpc.call("createTargets", null), [rpc]),
    [],
    open,
  );
  const teams = targets.status === "ready" ? targets.value.teams : [];

  // The panel's team filter is the best guess at intent: someone looking at
  // Design's list is probably filing into Design. Falls back to the first
  // write-scoped team, resolved once per open rather than in render.
  useEffect(() => {
    if (!open || teams.length === 0) return;
    setTeamId((current) => {
      if (current !== null && teams.some((team) => team.id === current)) return current;
      const preferred = teams.find((team) => team.id === currentTeamId);
      return (preferred ?? teams[0])!.id;
    });
  }, [open, teams, currentTeamId]);

  const submit = useCallback(() => {
    const trimmed = title.trim();
    if (trimmed === "" || teamId === null || busy) return;
    setBusy(true);
    void (async () => {
      try {
        const result = await rpc.call("createIssue", {
          teamId,
          title: trimmed,
          ...(description.trim() === "" ? {} : { description }),
        });
        if (!result.ok || result.identifier === null) {
          toast.error(result.message ?? "That didn't work.");
          return;
        }
        toast.success(`Created ${result.identifier}.`);
        setOpen(false);
        setTitle("");
        setDescription("");
        // Straight into the detail pane: state, assignee, priority and the
        // rest live there, which is what keeps this dialog two fields.
        navigate.toPluginPanel("linear", { subPath: `i/${result.identifier}` });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "That didn't work.");
      } finally {
        setBusy(false);
      }
    })();
  }, [rpc, navigate, title, description, teamId, busy]);

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label="New issue"
        onClick={() => setOpen(true)}
      >
        <Icon name="Plus" className="size-4" aria-hidden />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New issue</DialogTitle>
          </DialogHeader>

          <div className="space-y-3">
            <Input
              autoFocus
              placeholder="What needs doing?"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submit();
                }
              }}
              aria-label="Issue title"
            />
            <Textarea
              placeholder="Description — optional, Markdown"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className="min-h-20 text-sm"
              aria-label="Issue description"
            />
            {teams.length > 1 ? (
              <Select value={teamId ?? undefined} onValueChange={setTeamId}>
                <SelectTrigger className="h-8 text-sm" aria-label="Team">
                  <SelectValue placeholder="Team" />
                </SelectTrigger>
                <SelectContent>
                  {teams.map((team) => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.name}{" "}
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {team.key}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            {targets.status === "ready" && teams.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No team here has write access — bind one with{" "}
                <code className="text-foreground">bb linear bind &lt;TEAM-KEY&gt;</code>.
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              onClick={submit}
              disabled={busy || title.trim() === "" || teamId === null}
              size="sm"
            >
              {busy ? "Creating…" : "Create issue"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
