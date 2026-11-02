// Shown when the customer backs out of Stripe checkout. No charge happened.

import { Link, useSearchParams } from 'react-router-dom';

export default function BillingCancelPage() {
  const [params] = useSearchParams();
  const customerId = params.get('customer');

  return (
    <div className="max-w-lg mx-auto mt-16 card p-8 text-center space-y-4">
      <h1 className="page-title">Checkout canceled</h1>
      <p className="page-sub">
        No worries — nothing was charged and your workspace is unchanged.
        You can pick a package whenever you're ready.
      </p>
      <div className="pt-2">
        {customerId ? (
          <Link to={`/customers/${customerId}/billing`} className="btn-primary btn-sm">Back to billing</Link>
        ) : (
          <Link to="/dashboard" className="btn-primary btn-sm">Back to dashboard</Link>
        )}
      </div>
    </div>
  );
}
