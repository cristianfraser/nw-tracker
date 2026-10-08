-- Payslips rebuilt from other evidence (a month whose document was lost, the USD contract paid
-- without payslips) are marked as such, with what they were rebuilt from. Rows written by hand
-- before this column (source «synthetic:…») are rebuilt ones.
ALTER TABLE payroll_work_earnings ADD COLUMN origin TEXT NOT NULL DEFAULT 'document' CHECK (origin IN ('document', 'rebuilt'));
ALTER TABLE payroll_work_earnings ADD COLUMN rebuilt_basis TEXT;
UPDATE payroll_work_earnings SET origin = 'rebuilt' WHERE source_pdf LIKE 'synthetic:%';

-- Two more line kinds (the USD contract's fee and the transfer fee taken from it). A rebuilt USD
-- payslip's lines are in dollars, so an amount can carry cents.
CREATE TABLE payslip_lines_new (
  payslip_id INTEGER NOT NULL REFERENCES payroll_work_earnings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  side TEXT NOT NULL CHECK (side IN ('haber', 'descuento')),
  section TEXT CHECK (section IN ('imponible', 'no_imponible', 'legal', 'other')),
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  kind TEXT CHECK (kind IN (
    'base_salary', 'gratification', 'bonus', 'allowance', 'life_insurance_benefit', 'absence',
    'vacation_pay', 'indemnity_notice', 'indemnity_years_of_service', 'indemnity_voluntary', 'contractor_fee',
    'pension', 'health', 'health_additional', 'unemployment', 'income_tax', 'voluntary_pension',
    'life_insurance', 'advance', 'social_security', 'transfer_fee'
  )),
  PRIMARY KEY (payslip_id, position)
);
INSERT INTO payslip_lines_new (payslip_id, position, side, section, label, amount, kind)
  SELECT payslip_id, position, side, section, label, amount, kind FROM payslip_lines;
DROP TABLE payslip_lines;
ALTER TABLE payslip_lines_new RENAME TO payslip_lines;

-- An advance a payslip nets («Anticipo …») and the deposit that paid it earlier.
CREATE TABLE payslip_advances (
  payslip_id INTEGER NOT NULL REFERENCES payroll_work_earnings(id) ON DELETE CASCADE,
  movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
  PRIMARY KEY (payslip_id, movement_id)
);

-- Transfer and bank fees, under «Cuentas y servicios».
INSERT INTO cc_expense_categories (slug, label, label_i18n_key, sort_order, chart_color, parent_id)
SELECT 'fees', 'Comisiones', 'expenses.creditCard.categories.fees', 13, '#b45309', id
  FROM cc_expense_categories WHERE slug = 'bills'
   AND NOT EXISTS (SELECT 1 FROM cc_expense_categories WHERE slug = 'fees');
