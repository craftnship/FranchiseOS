import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { api, ApiError, isPortal, Me, setCurrentUser } from "./api";
import { useLoad } from "./hooks";
import { Layout } from "./components/Layout";
import { ErrorState } from "./components/ui";
import { Sites } from "./pages/Sites";
import { Territories } from "./pages/Territories";
import { Dashboard } from "./pages/Dashboard";
import { AgreementDetail, Agreements, Applications } from "./pages/Applications";
import { ApplicationDetail } from "./pages/ApplicationDetail";
import { Approvals } from "./pages/Approvals";
import { SiteDetail } from "./pages/SiteDetail";
import { Franchisees } from "./pages/Franchisees";
import { ProjectDetail, Projects } from "./pages/Projects";
import { PortalAgreement, PortalHome, PortalTasks } from "./pages/Portal";

// Catalyst's hosted sign-in page; it returns to the app after login.
const LOGIN_URL = "/__catalyst/auth/login";

function SignIn({ reason }: { reason?: string }) {
  return (
    <div className="signin-page">
      <div className="signin">
        <span className="brand-mark">F</span>
        <h1>Sign in to FranchiseOS</h1>
        <p>{reason ?? "Manage franchise expansion, agreements and store openings in one place."}</p>
        <a className="button" href={LOGIN_URL}>Continue to sign in</a>
      </div>
    </div>
  );
}

export function App() {
  const me = useLoad(() => api<Me>("GET", "/me"), []);
  if (me.loading && !me.data) return <div className="state" style={{ minHeight: "100vh" }}><span className="spinner" />Loading FranchiseOS…</div>;
  if (me.error) {
    const e = me.error as ApiError;
    if (e.code === "AUTH_REQUIRED") return <SignIn />;
    if (e.code === "ACCESS_DENIED") return <SignIn reason="Your sign-in worked, but this account isn't set up in FranchiseOS yet. Ask your administrator to add you." />;
    return <ErrorState error={e} retry={me.reload} />;
  }
  const user = me.data!;
  setCurrentUser(user);
  const portal = isPortal(user);
  return (
    <HashRouter>
      <Layout me={user}>
        <Routes>
          {portal ? (
            <>
              <Route path="/portal" element={<PortalHome />} />
              <Route path="/portal/tasks" element={<PortalTasks />} />
              <Route path="/portal/agreement" element={<PortalAgreement />} />
              <Route path="*" element={<Navigate to="/portal" replace />} />
            </>
          ) : (
            <>
              <Route path="/" element={<Dashboard />} />
              <Route path="/applications" element={<Applications />} />
              <Route path="/applications/:id" element={<ApplicationDetail />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:id" element={<ProjectDetail />} />
              <Route path="/agreements" element={<Agreements />} />
              <Route path="/agreements/:id" element={<AgreementDetail />} />
              <Route path="/franchisees" element={<Franchisees />} />
              <Route path="/territories" element={<Territories />} />
              <Route path="/sites" element={<Sites />} />
              <Route path="/sites/:id" element={<SiteDetail />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
      </Layout>
    </HashRouter>
  );
}
