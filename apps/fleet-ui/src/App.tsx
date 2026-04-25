import { Route, Routes } from "react-router-dom";
import { AuthProbe } from "@/auth/AuthProbe";
import { RequireAuth } from "@/auth/RequireAuth";
import { Layout } from "@/components/Layout";
import { Toaster } from "@/components/Toaster";
import { Login } from "@/pages/Login";
import { Overview } from "@/pages/Overview";
import { Collectors } from "@/pages/Collectors";
import { CollectorDetail } from "@/pages/CollectorDetail";
import { Pipelines } from "@/pages/Pipelines";
import { PipelineNew } from "@/pages/PipelineNew";
import { PipelineEdit } from "@/pages/PipelineEdit";
import { Audit } from "@/pages/Audit";
import { Catalog } from "@/pages/Catalog";
import { SettingsAccount } from "@/pages/SettingsAccount";
import { SettingsTokens } from "@/pages/SettingsTokens";
import { SettingsUsers } from "@/pages/SettingsUsers";
import { SettingsRoles } from "@/pages/SettingsRoles";
import { SettingsIdentityProviders } from "@/pages/SettingsIdentityProviders";
import { SettingsSsoActivity } from "@/pages/SettingsSsoActivity";

export default function App() {
  return (
    <AuthProbe>
      {/* Toaster is rendered once at the root so any component can call
          useToastStore().push(...) regardless of route. Sits outside
          <Routes> so a route change doesn't unmount in-flight toasts. */}
      <Toaster />
      <Routes>
        {/* Public routes — no auth required. */}
        <Route path="/login" element={<Login />} />

        {/* Authenticated routes — RequireAuth bounces unauthenticated
            users to /login?next=<currentPath>. */}
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route index element={<Overview />} />
          <Route path="collectors" element={<Collectors />} />
          <Route path="collectors/:id" element={<CollectorDetail />} />
          <Route path="pipelines" element={<Pipelines />} />
          <Route path="pipelines/new" element={<PipelineNew />} />
          <Route path="pipelines/:id" element={<PipelineEdit />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="audit" element={<Audit />} />
          <Route path="settings/account" element={<SettingsAccount />} />
          <Route path="settings/tokens" element={<SettingsTokens />} />
          <Route path="settings/users" element={<SettingsUsers />} />
          <Route path="settings/roles" element={<SettingsRoles />} />
          <Route
            path="settings/identity-providers"
            element={<SettingsIdentityProviders />}
          />
          <Route path="settings/sso-activity" element={<SettingsSsoActivity />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </AuthProbe>
  );
}

function NotFound() {
  return (
    <div className="card p-8 text-center">
      <h2 className="text-lg font-semibold">Not found</h2>
      <p className="text-sm text-muted mt-2">
        That URL doesn't match any known page.
      </p>
    </div>
  );
}
