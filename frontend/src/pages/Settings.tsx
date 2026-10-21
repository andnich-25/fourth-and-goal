import { useTheme, type Theme } from "@/lib/state";
import { PageTitle } from "@/components/Layout";
import { Badge, Card, CardBody, CardHeader, Segmented } from "@/components/ui";

export default function SettingsPage() {
  const [theme, setTheme] = useTheme();
  return (
    <div className="space-y-5">
      <PageTitle title="Settings" />
      <Card>
        <CardHeader title="Appearance" />
        <CardBody>
          <Segmented<Theme> label="Theme" value={theme} onChange={setTheme} options={[{ value: "dark", label: "Dark" }, { value: "light", label: "Light" }, { value: "system", label: "System" }]} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="About" />
        <CardBody className="space-y-2 text-sm text-muted">
          <p>Fourth &amp; Goal Analytics is a local-first research tool. It is not a wagering platform and never labels a pick as guaranteed. If you bet, set limits in advance and never raise stakes to chase losses.</p>
          <p>Times display in Central time (America/Chicago); stored timestamps are ISO 8601 UTC. <Badge>v1.0.0</Badge></p>
        </CardBody>
      </Card>
    </div>
  );
}
