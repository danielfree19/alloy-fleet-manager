import { Route, Routes } from "react-router-dom";
import { TokenGate } from "@/auth/TokenGate";
import { Layout } from "@/components/Layout";
import { Overview } from "@/pages/Overview";
import { Collectors } from "@/pages/Collectors";
import { CollectorDetail } from "@/pages/CollectorDetail";
import { Pipelines } from "@/pages/Pipelines";
import { PipelineNew } from "@/pages/PipelineNew";
import { PipelineEdit } from "@/pages/PipelineEdit";
import { Audit } from "@/pages/Audit";
import { Catalog } from "@/pages/Catalog";

export default function App() {
  return (
    <TokenGate>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="collectors" element={<Collectors />} />
          <Route path="collectors/:id" element={<CollectorDetail />} />
          <Route path="pipelines" element={<Pipelines />} />
          <Route path="pipelines/new" element={<PipelineNew />} />
          <Route path="pipelines/:id" element={<PipelineEdit />} />
          <Route path="catalog" element={<Catalog />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </TokenGate>
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
