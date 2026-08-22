import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/** The one shape a confirmation needs. Both the list rows and the detail
 *  pane satisfy it structurally, which is the point: one dialog, one copy of
 *  the warning, wherever the archive is asked for. */
export interface ArchiveTarget {
  id: string;
  identifier: string;
  title: string;
}

/**
 * The archive confirmation.
 *
 * "Reversible in Linear" is in the body on purpose: archive sits next to
 * destructive-looking actions everywhere else, and a person deserves to be
 * told which kind this is before they press it, not after.
 */
export function ArchiveDialog({
  target,
  onCancel,
  onConfirm,
}: {
  target: ArchiveTarget | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Archive {target?.identifier ?? "this issue"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {target === null ? null : (
              <>
                <strong>{target.title}</strong>
                <br />
                <br />
              </>
            )}
            This archives the issue in Linear, for everyone — not just in bb. It is{" "}
            <strong>reversible</strong> in Linear&apos;s own UI, and it is not a delete.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep it</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className="bg-destructive text-white hover:bg-destructive/90"
          >
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
