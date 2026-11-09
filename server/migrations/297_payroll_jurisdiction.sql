-- Payroll per jurisdiction (docs/demo-us-chapter-plan.md): a payslip is Chilean (a liquidación,
-- monthly, Previred's parameters) or US federal (a W-2 pay stub, biweekly or semi-monthly, the
-- law in `usLegalParameters.ts`). Every existing payslip is Chilean — the USD contract's rebuilt
-- payslips too: dollars under Chilean rules.
--
-- `pay_period`: how often the employer pays (several US payslips share a `period_month`; the
-- document is still each one's identity). `pay_date`: the stub's pay date (US payslips; the FICA
-- year-to-date and the withholding year run on it). `w4_filing_status`: the Form W-4 (2020 or
-- later) the employer withholds with, Step 1(c) only (no Step 2 checkbox, credits or adjustments).
-- For a US payslip `employer_rut` holds the employer's EIN, and the Chilean `*_clp` columns stay null.
ALTER TABLE payroll_work_earnings ADD COLUMN jurisdiction TEXT NOT NULL DEFAULT 'cl' CHECK (jurisdiction IN ('cl', 'us'));
ALTER TABLE payroll_work_earnings ADD COLUMN pay_period TEXT NOT NULL DEFAULT 'monthly' CHECK (pay_period IN ('monthly', 'biweekly', 'semi_monthly'));
ALTER TABLE payroll_work_earnings ADD COLUMN pay_date TEXT CHECK (pay_date IS NULL OR pay_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]');
ALTER TABLE payroll_work_earnings ADD COLUMN w4_filing_status TEXT CHECK (w4_filing_status IS NULL OR w4_filing_status IN ('single', 'married_jointly'));

-- US line kinds (`payslipLineKinds.ts`), and a `memo` side: a line the stub prints that is neither
-- paid nor withheld (the employer's 401(k) match), so it is outside haberes − descuentos = net.
CREATE TABLE payslip_lines_new (
  payslip_id INTEGER NOT NULL REFERENCES payroll_work_earnings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  side TEXT NOT NULL CHECK (side IN ('haber', 'descuento', 'memo')),
  section TEXT CHECK (section IN ('imponible', 'no_imponible', 'legal', 'other')),
  label TEXT NOT NULL,
  amount REAL NOT NULL,
  kind TEXT CHECK (kind IN (
    'base_salary', 'gratification', 'bonus', 'allowance', 'life_insurance_benefit', 'absence',
    'vacation_pay', 'indemnity_notice', 'indemnity_years_of_service', 'indemnity_voluntary', 'contractor_fee',
    'pension', 'health', 'health_additional', 'unemployment', 'income_tax', 'voluntary_pension',
    'life_insurance', 'advance', 'social_security', 'transfer_fee',
    'wages', 'supplemental_bonus', 'rsu',
    'federal_income_tax', 'social_security_tax', 'medicare_tax', 'retirement_401k_pretax', 'retirement_401k_roth',
    'hsa', 'health_premium', 'dental_vision', 'rsu_offset',
    'employer_401k_match'
  )),
  PRIMARY KEY (payslip_id, position)
);
INSERT INTO payslip_lines_new (payslip_id, position, side, section, label, amount, kind)
  SELECT payslip_id, position, side, section, label, amount, kind FROM payslip_lines;
DROP TABLE payslip_lines;
ALTER TABLE payslip_lines_new RENAME TO payslip_lines;
