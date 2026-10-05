import { AlertTriangle } from "lucide-react";

export function TransferProblem({ message, details }: { message: string; details?: string | null }) {
  return <div className="transfer-problem">
    <div className="status-box error compact-status" role="alert"><AlertTriangle size={17} /><span>{message}</span></div>
    {details && <details className="transfer-error-details">
      <summary>Error details</summary>
      <pre>{details}</pre>
    </details>}
  </div>;
}
