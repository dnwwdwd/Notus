import { SettingsScreen, SETTINGS_SECTIONS } from '../../components/Settings/SettingsScreen';

export async function getServerSideProps({ params }) {
  const validSections = new Set(SETTINGS_SECTIONS.map((item) => item.id));
  if (!validSections.has(params.section)) {
    return { notFound: true };
  }

  return {
    props: {
      section: params.section,
    },
  };
}

export default function SettingsSectionPage({ section }) {
  return <SettingsScreen section={section} />;
}
