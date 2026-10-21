import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import "./index.css";
import { Layout } from "./components/Layout";
import { PinProvider } from "./lib/state";
import Overview from "./pages/Overview";
import Rankings from "./pages/Rankings";
import Parlay from "./pages/Parlay";
import Defenses from "./pages/Defenses";
import DefenseDetail from "./pages/DefenseDetail";
import Player from "./pages/Player";
import Backtest from "./pages/Backtest";
import DataSync from "./pages/DataSync";
import SettingsPage from "./pages/Settings";
import { EmptyState } from "./components/ui";

const qc = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false, placeholderData: (prev: unknown) => prev } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <PinProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Overview />} />
              <Route path="rankings" element={<Rankings />} />
              <Route path="parlay" element={<Parlay />} />
              <Route path="defenses" element={<Defenses />} />
              <Route path="defenses/:team" element={<DefenseDetail />} />
              <Route path="players/:id" element={<Player />} />
              <Route path="backtest" element={<Backtest />} />
              <Route path="data" element={<DataSync />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<EmptyState title="Page not found">That route does not exist.</EmptyState>} />
            </Route>
          </Routes>
        </PinProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
