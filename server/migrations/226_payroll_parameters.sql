-- A payroll month's legal parameters as Previred states them (`payroll.parameters`): UF, UTM, the
-- taxable caps in UF, the employer's share into the worker's AFP account (pension reform, from
-- August 2025) and an indefinite contract's unemployment-insurance rates; each AFP's rate charged
-- to the worker in its own table. Percents (10.46 = 10,46 %).
CREATE TABLE payroll_parameters (
  period_month TEXT PRIMARY KEY CHECK (period_month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  uf REAL NOT NULL,
  utm REAL NOT NULL,
  pension_cap_uf REAL NOT NULL,
  unemployment_cap_uf REAL NOT NULL,
  afp_employer_rate REAL NOT NULL,
  afc_worker_rate REAL NOT NULL,
  afc_employer_rate REAL NOT NULL,
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE payroll_afp_rates (
  period_month TEXT NOT NULL REFERENCES payroll_parameters(period_month) ON DELETE CASCADE,
  afp TEXT NOT NULL,
  worker_rate REAL NOT NULL,
  PRIMARY KEY (period_month, afp)
);

-- The AFP a payslip's pension contribution went to, as the payslip names it (lowercase:
-- planvital, modelo, uno, …); null when the payslip names none.
ALTER TABLE payroll_work_earnings ADD COLUMN pension_fund TEXT;
