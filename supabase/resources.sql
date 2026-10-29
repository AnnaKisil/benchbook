-- The lab's robots and computers. Run this once in the SQL Editor after schema.sql.
-- Rows whose ID (code) already exists are left untouched, so it is safe to re-run.
-- Afterwards, admins can edit everything under Manage → Resources in the app.

insert into public.resources (code, name, kind, location, description)
select v.code, v.name, v.kind, v.location, v.description
from (values
  ('R01', 'FR3 - Aurora', 'Robot',    'ACL-DIF', 'Franka-Research 3: For maintenance'),
  ('R02', 'FR3 - Flora',  'Robot',    'ACL-DIF', 'Franka-Research 3: Mostly for scooping - Robotiq 85 parallel mounted'),
  ('R03', 'FP3',          'Robot',    'ACL-DIF', 'Franka Production 3: Grey FR3 - Franka Hand'),
  ('R04', 'UR7e',         'Robot',    'ACL-DIF', 'Universal Robotics 7 - F/T sensor, Robotiq 85 gripper'),
  ('R05', 'FER',          'Robot',    'ACL-DIF', 'Franka Emika Panda - Franka Hand'),
  ('C01', 'Hadrian',      'Computer', 'ACL-DIF', 'i7/4090/64'),
  ('C02', 'Tiberius',     'Computer', 'ACL-DIF', 'i7/5090/128'),
  ('C03', 'Augustus',     'Computer', 'ACL-DIF', 'Tx 9970 x/509/128'),
  ('C04', 'Sim2real',     'Computer', 'ACL-DIF', 'i7/4090/64'),
  ('C05', '3080',         'Computer', 'ACL-DIF', 'i7/3080/64')
) as v(code, name, kind, location, description)
where not exists (select 1 from public.resources r where r.code = v.code);
