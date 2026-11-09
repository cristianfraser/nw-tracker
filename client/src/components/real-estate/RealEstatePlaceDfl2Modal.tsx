import { useEffect, useState } from "react";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../../i18n";
import { useSetRealEstatePlaceDfl2Mutation } from "../../queries/mutations";
import type { RealEstatePlaceDto } from "../../types";
import { Button } from "@crfrsr/ui";
import { RealEstateDfl2Fields, dfl2BodyFromDraft, dfl2DraftFromPlace, type Dfl2Draft } from "./RealEstateDfl2Fields";

/** Edit a place's DFL-2 declaration. */
export function RealEstatePlaceDfl2Modal({ place, onClose }: { place: RealEstatePlaceDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const mutation = useSetRealEstatePlaceDfl2Mutation();
  const [draft, setDraft] = useState<Dfl2Draft | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  useEffect(() => {
    setDraft(place ? dfl2DraftFromPlace(place) : null);
    setInputError(null);
    mutation.reset();
    // Only a new place resets the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place?.slug]);

  const err = inputError ?? (mutation.error instanceof Error ? mutation.error.message : null);
  const save = async () => {
    if (!place || !draft) return;
    let body: ReturnType<typeof dfl2BodyFromDraft>;
    try {
      body = dfl2BodyFromDraft(draft);
    } catch (e) {
      setInputError(e instanceof Error ? e.message : String(e));
      return;
    }
    setInputError(null);
    await mutation.mutateAsync({ slug: place.slug, ...body });
    onClose();
  };

  return (
    <Modal
      open={place != null}
      onClose={onClose}
      title={t("expenses.realEstate.dfl2ModalTitle", { place: place?.label ?? "" })}
      closeAriaLabel={t("expenses.realEstate.linkModalClose")}
    >
      {draft ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "26rem" }}>
          <RealEstateDfl2Fields value={draft} onChange={setDraft} />
          {err ? <p className="error">{err}</p> : null}
          <div>
            <Button disabled={mutation.isPending} onClick={() => void save()}>
              {mutation.isPending ? t("common.loading") : t("expenses.realEstate.dfl2Save")}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
