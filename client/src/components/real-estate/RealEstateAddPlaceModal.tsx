import { useState } from "react";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../../i18n";
import { useRealEstatePropertyAccounts } from "../../queries/hooks";
import { useCreateRealEstatePlaceMutation } from "../../queries/mutations";
import { Button, Field, Input } from "@crfrsr/ui";

function slugFromLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

type Props = {
  open: boolean;
  onClose: () => void;
};

/**
 * Create a tracked place (rental or owned). Owned places pick their net-worth property
 * account so the mortgage ledger rows attach automatically.
 */
export function RealEstateAddPlaceModal({ open, onClose }: Props) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [activeFrom, setActiveFrom] = useState("");
  const [activeTo, setActiveTo] = useState("");
  const [propertyAccountId, setPropertyAccountId] = useState<string>("");
  const { data: propertyData } = useRealEstatePropertyAccounts(open);
  const createMutation = useCreateRealEstatePlaceMutation();

  const err = createMutation.error instanceof Error ? createMutation.error.message : null;

  const handleLabelChange = (value: string) => {
    setLabel(value);
    if (!slugTouched) setSlug(slugFromLabel(value));
  };

  const handleCreate = async () => {
    await createMutation.mutateAsync({
      slug,
      label,
      active_from: activeFrom.trim() || null,
      active_to: activeTo.trim() || null,
      property_account_id: propertyAccountId ? Number(propertyAccountId) : null,
    });
    setLabel("");
    setSlug("");
    setSlugTouched(false);
    setActiveFrom("");
    setActiveTo("");
    setPropertyAccountId("");
    onClose();
  };


  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("expenses.realEstate.addPlaceModalTitle")}
      closeAriaLabel={t("expenses.realEstate.linkModalClose")}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", maxWidth: "26rem" }}>
        <Field label={t("expenses.realEstate.placeLabelField")}>
          <Input type="text" value={label} onChange={(e) => handleLabelChange(e.target.value)} />
        </Field>
        <Field label={t("expenses.realEstate.placeSlugField")}>
          <Input
            type="text"
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value);
            }}
          />
        </Field>
        <div style={{ display: "flex", gap: "0.75rem" }}>
          <Field label={t("expenses.realEstate.placeFromField")} style={{ flex: 1 }}>
            <Input
              type="text"
              inputMode="numeric"
              placeholder="2026-01"
              value={activeFrom}
              onChange={(e) => setActiveFrom(e.target.value)}
            />
          </Field>
          <Field label={t("expenses.realEstate.placeToField")} style={{ flex: 1 }}>
            <Input
              type="text"
              inputMode="numeric"
              placeholder=""
              value={activeTo}
              onChange={(e) => setActiveTo(e.target.value)}
            />
          </Field>
        </div>
        <Field label={t("expenses.realEstate.placePropertyField")}>
          <select value={propertyAccountId} onChange={(e) => setPropertyAccountId(e.target.value)}>
            <option value="">{t("expenses.realEstate.placePropertyNone")}</option>
            {(propertyData?.accounts ?? []).map((a) => (
              <option key={a.id} value={String(a.id)}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        {err ? <p className="error">{err}</p> : null}
        <div>
          <Button size="sm"
            disabled={createMutation.isPending || !label.trim() || !slug.trim()}
            onClick={() => void handleCreate()}
          >
            {createMutation.isPending
              ? t("common.loading")
              : t("expenses.realEstate.placeCreate")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
