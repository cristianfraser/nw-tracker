-- Two names the checking listing prints that the catalog missed, written by the hook
-- `runVendorCatalog363` (vendorCatalog363.ts):
-- * an ATM withdrawal printed «Giro Nacional VD», which 248's «GIRO EN CAJERO AUTOMATICO» prefix
--   never reaches: a prefix entry «GIRO NACIONAL» → «Cajero automático»;
-- * Clínica Alemana's RUT (96.770.100-9), which the cartola prints before its refunds
--   («0967701009 DEVOLUCION CLINICA ALE», the name cut): a RUT entry → «Clínica Alemana».
SELECT 1;
