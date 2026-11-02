import { createBrowserRouter, Navigate } from 'react-router-dom';
import Layout from './Layout';
import DashboardPage from '../features/dashboard/DashboardPage';
import ProjectDetailPage from '../features/projects/ProjectDetailPage';
import ImportPage from '../features/import/ImportPage';
import ToolsPage from '../features/tools/ToolsPage';
import ToolDetailPage from '../features/tools/ToolDetailPage';
import ReviewPage from '../features/review/ReviewPage';
import EvaluatePage from '../features/evaluate/EvaluatePage';
import PublishPage from '../features/publish/PublishPage';
import OperatePage from '../features/operate/OperatePage';
import ProjectsPage from '../features/projects/ProjectsPage';
import NewProjectPage from '../features/projects/NewProjectPage';
import CustomersPage from '../features/admin/CustomersPage';
import CustomerUsersPage from '../features/customers/CustomerUsersPage';
import BillingPage from '../features/billing/BillingPage';
import BillingSuccessPage from '../features/billing/BillingSuccessPage';
import BillingCancelPage from '../features/billing/BillingCancelPage';
import AuthCallbackPage from '../features/auth/AuthCallbackPage';
import AuthGate from '../features/auth/AuthGate';
import SignupPage from '../features/auth/SignupPage';
import CreateOrganizationPage from '../features/onboarding/CreateOrganizationPage';
import OnboardingWizardPage from '../features/onboarding/OnboardingWizardPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AuthGate><Layout /></AuthGate>,
    children: [
      { index: true, element: <Navigate to="/dashboard" replace /> },
      { path: 'dashboard', element: <DashboardPage /> },
      { path: 'import', element: <ImportPage /> },
      { path: 'tools', element: <ToolsPage /> },
      { path: 'tools/:toolName', element: <ToolDetailPage /> },
      { path: 'review', element: <ReviewPage /> },
      { path: 'evaluate', element: <EvaluatePage /> },
      { path: 'publish', element: <PublishPage /> },
      { path: 'operate', element: <OperatePage /> },
      { path: 'projects', element: <ProjectsPage /> },
      { path: 'projects/new', element: <NewProjectPage /> },
      { path: 'projects/:id', element: <ProjectDetailPage /> },
      // FE-07: self-serve organization creation for membership-less users.
      { path: 'organizations/new', element: <CreateOrganizationPage /> },
      // FE-02: guided onboarding — new users land here right after creating
      // their organization, on the way from zero to first import.
      { path: 'onboarding', element: <OnboardingWizardPage /> },
      { path: 'admin/customers', element: <CustomersPage /> },
      { path: 'customers/:id/users', element: <CustomerUsersPage /> },
      { path: 'customers/:id/billing', element: <BillingPage /> },
      { path: 'billing/success', element: <BillingSuccessPage /> },
      { path: 'billing/cancel', element: <BillingCancelPage /> },
      // FE-01: Cognito hosted-UI callback (inert until VITE_COGNITO_* is configured).
      { path: 'auth/callback', element: <AuthCallbackPage /> },
      // Website "Start free" → hosted sign-up.
      { path: 'signup', element: <SignupPage /> },
    ],
  },
]);
