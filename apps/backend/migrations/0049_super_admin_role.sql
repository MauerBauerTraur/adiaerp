-- Add super_admin role to the user_role enum.
-- super_admin has the same chain-wide access as pm but is explicitly
-- displayed as "Super admin" in the UI (distinct from "PM").
-- Both pm and super_admin bypass authorizeWrite restrictions.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin';
