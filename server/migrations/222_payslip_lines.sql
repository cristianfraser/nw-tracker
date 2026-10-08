-- Every printed line of a payslip (liquidación), as printed: the haberes and descuentos with
-- their label and amount, in the section the payslip puts them when it shows one. Written by
-- `employment.payslips` v2, replaced as a whole on each re-import of the payslip.
CREATE TABLE payslip_lines (
  payslip_id INTEGER NOT NULL REFERENCES payroll_work_earnings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  side TEXT NOT NULL CHECK (side IN ('haber', 'descuento')),
  section TEXT CHECK (section IN ('imponible', 'no_imponible', 'legal', 'other')),
  label TEXT NOT NULL,
  amount INTEGER NOT NULL,
  PRIMARY KEY (payslip_id, position)
);
