import { PortalSales, Royalties } from "./components/Royalties";
import { Analytics } from "./pages/Analytics";
import { PortalConstruction } from "./components/Construction";
import { PortalTeam } from "./components/Staffing";
import { PortalOrders, Vendors } from "./components/Purchasing";
import { Fees, PortalFunding } from "./components/Funding";
import { AuditPage, Audits, PortalAudits } from "./components/Audits";
import { Launches, PortalLaunch, Renewals } from "./components/Launch";
import { BrandDocuments, MessagesInbox, MessageThread, PortalDocuments, PortalMessages, PortalTodo } from "./components/PortalHub";
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
import { PortalApplication, PortalSite } from "./pages/PortalApplication";
import { AuditLog } from "./pages/Audit";
import { Users } from "./pages/Users";
import { Integrations } from "./pages/Integrations";
import { Settings } from "./pages/Settings";
import { Brand, BrandContext, BrandMark, DEFAULT_BRAND, useApplyBrand } from "./branding";

// Catalyst's hosted sign-in page; it returns to the app after login.
const LOGIN_URL = "/__catalyst/auth/login";

function SignIn({ reason, brand }: { reason?: string; brand: Brand }) {
  return (
    <div className="signin-page">
      <div className="signin">
        <BrandMark brand={brand} />
        <h1>Sign in to {brand.name}</h1>
        <p>{reason ?? "Manage franchise expansion, agreements and store openings in one place."}</p>
        <a className="button" href={LOGIN_URL}>Continue to sign in</a>
      </div>
    </div>
  );
}

export function App() {
  const me = useLoad(() => api<Me>("GET", "/me"), []);
  // Branding never blocks the app: if it can't load, FranchiseOS's own look stays.
  const branding = useLoad(() => api<Brand>("GET", "/branding").catch(() => DEFAULT_BRAND), []);
  const brand = branding.data ?? DEFAULT_BRAND;
  useApplyBrand(brand);
  if ((me.loading && !me.data) || (branding.loading && !branding.data)) return <div className="state" style={{ minHeight: "100vh" }}><span className="spinner" />Loading…</div>;
  if (me.error) {
    const e = me.error as ApiError;
    if (e.code === "AUTH_REQUIRED") return <SignIn brand={brand} />;
    if (e.code === "ACCESS_DENIED") return <SignIn brand={brand} reason={`Your sign-in worked, but this account isn't set up in ${brand.name} yet. Ask your administrator to add you.`} />;
    return <ErrorState error={e} retry={me.reload} />;
  }
  const user = me.data!;
  setCurrentUser(user);
  const portal = isPortal(user);
  return (
    <BrandContext.Provider value={{ brand, reload: branding.reload }}>
    <HashRouter>
      <Layout me={user}>
        <Routes>
          {portal ? (
            <>
              <Route path="/portal" element={<PortalHome />} />
              <Route path="/portal/tasks" element={<PortalTasks />} />
              <Route path="/portal/application" element={<PortalApplication />} />
              <Route path="/portal/site" element={<PortalSite />} />
              <Route path="/portal/agreement" element={<PortalAgreement />} />
              <Route path="/portal/sales" element={<PortalSales />} />
              <Route path="/portal/construction" element={<PortalConstruction />} />
              <Route path="/portal/team" element={<PortalTeam />} />
              <Route path="/portal/orders" element={<PortalOrders />} />
              <Route path="/portal/funding" element={<PortalFunding />} />
              <Route path="/portal/audits" element={<PortalAudits />} />
              <Route path="/portal/launch" element={<PortalLaunch />} />
              <Route path="/portal/todo" element={<PortalTodo />} />
              <Route path="/portal/documents" element={<PortalDocuments />} />
              <Route path="/portal/messages" element={<PortalMessages />} />
              <Route path="/portal/audits/:id" element={<AuditPage portal />} />
              <Route path="*" element={<Navigate to="/portal" replace />} />
            </>
          ) : (
            <>
              <Route path="/" element={<Dashboard />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/applications" element={<Applications />} />
              <Route path="/applications/:id" element={<ApplicationDetail />} />
              <Route path="/projects" element={<Projects />} />
              <Route path="/projects/:id" element={<ProjectDetail />} />
              <Route path="/royalties" element={<Royalties />} />
              <Route path="/vendors" element={<Vendors />} />
              <Route path="/fees" element={<Fees />} />
              <Route path="/audits" element={<Audits />} />
              <Route path="/launches" element={<Launches />} />
              <Route path="/renewals" element={<Renewals />} />
              <Route path="/messages" element={<MessagesInbox />} />
              <Route path="/messages/:id" element={<MessageThread />} />
              <Route path="/documents" element={<BrandDocuments />} />
              <Route path="/audits/:id" element={<AuditPage />} />
              <Route path="/agreements" element={<Agreements />} />
              <Route path="/agreements/:id" element={<AgreementDetail />} />
              <Route path="/franchisees" element={<Franchisees />} />
              <Route path="/territories" element={<Territories />} />
              <Route path="/sites" element={<Sites />} />
              <Route path="/sites/:id" element={<SiteDetail />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/admin/activity" element={<AuditLog />} />
              <Route path="/admin/users" element={<Users />} />
              <Route path="/admin/integrations" element={<Integrations />} />
              <Route path="/admin/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </>
          )}
        </Routes>
      </Layout>
    </HashRouter>
    </BrandContext.Provider>
  );
}
