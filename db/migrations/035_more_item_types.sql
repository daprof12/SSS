-- The product range as types everywhere an agency or the platform lists kit: infrastructure assets,
-- billed equipment and store stock. Each list also takes "Other" for kit that fits no type.

alter table agency_assets drop constraint agency_assets_kind_check;
alter table agency_assets add constraint agency_assets_kind_check check (kind in (
  'traffic_light', 'street_light', 'camera', 'smart_pole', 'sensor', 'drone_house', 'solar_panel', 'other'));

alter table store_stock drop constraint store_stock_item_check;
alter table store_stock add constraint store_stock_item_check check (item in (
  'camera', 'street_light', 'gateway', 'drone', 'battery', 'solar_panel', 'pole', 'smart_pole', 'defence_drone', 'fire_drone', 'body_cam', 'sensor', 'other'));

insert into agency_fees (code, label, amount_kobo, cycle) values
  ('inventory_defence_drone', 'Defence drone',              2500000, 'per_item_monthly'),
  ('inventory_fire_drone',    'Fire-fighter drone',         2500000, 'per_item_monthly'),
  ('inventory_body_cam',      'Officer body cam',            200000, 'per_item_monthly'),
  ('inventory_camera',        'Camera',                      300000, 'per_item_monthly'),
  ('inventory_sensor',        'Security sensor and alert device', 100000, 'per_item_monthly'),
  ('inventory_smart_pole',    'Smart street light',         1500000, 'per_item_monthly'),
  ('inventory_other',         'Other equipment',             100000, 'per_item_monthly')
on conflict do nothing;
