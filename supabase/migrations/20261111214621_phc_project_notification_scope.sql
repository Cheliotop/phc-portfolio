-- Project-linked notification content must follow the same current-assignment
-- boundary; account-only notifications retain their existing self policy.
CREATE POLICY current_assignment_read_boundary ON public.notifications
AS RESTRICTIVE FOR SELECT TO authenticated
USING (related_project IS NULL OR public.can_read_current_project(related_project));
