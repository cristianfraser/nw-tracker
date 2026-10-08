-- What each printed payslip line is (`payslipLineKinds.ts`), written by the payslip import; the
-- next import fills the lines stored before this column existed (readers refuse a NULL kind).
ALTER TABLE payslip_lines ADD COLUMN kind TEXT CHECK (kind IN (
  'base_salary', 'gratification', 'bonus', 'allowance', 'life_insurance_benefit', 'absence',
  'vacation_pay', 'indemnity_notice', 'indemnity_years_of_service', 'indemnity_voluntary',
  'pension', 'health', 'health_additional', 'unemployment', 'income_tax', 'voluntary_pension',
  'life_insurance', 'advance', 'social_security'
));

-- The payroll month(s) a pension / unemployment / APV contribution pays (the certificate's
-- «período»). Written by the AFP certificate read and the AFC certificate import; one movement
-- can pay two months and one month can have several movements. A payslip's contributions are the
-- movements whose period is its month: this replaces the note as the home of the period.
CREATE TABLE pension_contribution_periods (
  movement_id INTEGER NOT NULL REFERENCES movements(id) ON DELETE CASCADE,
  period_month TEXT NOT NULL CHECK (period_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  PRIMARY KEY (movement_id, period_month)
);
CREATE INDEX idx_pension_contribution_periods_month ON pension_contribution_periods(period_month);
