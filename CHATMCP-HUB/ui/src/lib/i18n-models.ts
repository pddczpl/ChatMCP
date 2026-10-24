// The strings that only the model picker asks for (the list under the model field of the AI settings, the badges of a model, the line that tells which list of models the Hub knows and
// updates it), in both languages. They load with the picker, which is a script of its own fetched when the AI settings open: this module adds them to the dictionary (addTranslations)
// as it is evaluated, and every module that asks for one imports it. A string a first-screen module also asks for does NOT belong here: it goes in i18n.ts.

import { addTranslations } from './i18n.ts';

export const modelsVi = {
  // The list
  ai_model_browse: 'Chọn model từ danh sách',
  ai_model_list_label: 'Danh sách model',
  ai_model_loading: 'Đang tải danh sách…',
  ai_model_no_catalog: 'Hub chưa có danh sách model cho kết nối này (máy chủ riêng hoặc chạy trên máy này). Hãy gõ tên model.',
  ai_model_count: 'Hiển thị {shown} trong {total} model. Gõ để lọc.',
  ai_model_source: 'Danh sách: {source}',
  ai_model_load_account: 'Chỉ hiện model của tài khoản',
  ai_model_load_account_hint: 'Hỏi nhà cung cấp khóa API đã lưu dùng được model nào (khóa chỉ đi tới nhà cung cấp của bạn).',
  ai_model_account_loaded: 'Đã tải {n} model của tài khoản.',
  ai_model_account_failed: 'Không tải được model của tài khoản.',
  ai_model_account_save_first: 'Lưu cấu hình này trước, rồi mới tải được model của tài khoản.',

  // What the catalog says about a model
  ai_model_facts_known: 'Danh mục ({source}):',
  ai_model_facts_alias: 'Giống {id} trong danh mục ({source}), nhưng Hub không dựa vào đó để lập kế hoạch hay tính giá.',
  ai_model_badge_context: '{size} ngữ cảnh',
  ai_model_badge_context_limited: '{size} ngữ cảnh, đầu vào tối đa {input}',
  ai_model_badge_price: '{price} mỗi 1M token',
  ai_model_badge_tiered: 'giá theo bậc',
  ai_model_badge_think: 'suy luận',
  ai_model_badge_tools: 'công cụ',
  ai_model_badge_vision: 'đọc ảnh',
  ai_model_badge_account: 'trong tài khoản',
  ai_model_status_alpha: 'alpha',
  ai_model_status_beta: 'beta',
  ai_model_status_deprecated: 'ngừng hỗ trợ',
  ai_model_status_not_stable: 'chưa ổn định',

  // The list of models the Hub knows, and its update
  ai_catalog_title: 'Danh sách model của Hub',
  ai_catalog_line: '{label} · {source} · {age} · {models} model',
  ai_catalog_source_bundled: 'đi kèm Hub',
  ai_catalog_source_refreshed: 'bạn đã cập nhật',
  ai_catalog_age_today: 'hôm nay',
  ai_catalog_age_one: '1 ngày tuổi',
  ai_catalog_age_other: '{n} ngày tuổi',
  ai_catalog_update: 'Cập nhật từ models.dev',
  ai_catalog_updating: 'Đang cập nhật…',
  ai_catalog_privacy: 'Chỉ khi bạn bấm: Hub tải một danh sách công khai từ models.dev. Không gửi khóa API, dự án hay nội dung của bạn. Nếu có lỗi, danh sách đang dùng giữ nguyên.',
  ai_catalog_updated: 'Đã cập nhật danh sách model: {label} ({models} model).',
  ai_catalog_failed: 'Chưa cập nhật được danh sách model: {error} Danh sách đang dùng không đổi.',
  ai_catalog_ignored: 'Hub đã bỏ qua danh sách lưu trong thư mục dữ liệu ({reason}) và dùng danh sách đi kèm.',
  ai_catalog_ignored_damaged: 'tệp hỏng',
  ai_catalog_ignored_older: 'cũ hơn danh sách đi kèm',
  ai_catalog_ignored_future: 'đề ngày trong tương lai',
};

export const modelsEn: Record<keyof typeof modelsVi, string> = {
  ai_model_browse: 'Choose a model from the list',
  ai_model_list_label: 'Models',
  ai_model_loading: 'Loading the list…',
  ai_model_no_catalog: 'The Hub has no list of models for this connection (a private server, or one on this machine). Type the model name.',
  ai_model_count: 'Showing {shown} of {total} models. Type to filter.',
  ai_model_source: 'List: {source}',
  ai_model_load_account: 'Show only my account\'s models',
  ai_model_load_account_hint: 'Asks your provider which models the saved API key can use (the key goes to your provider only).',
  ai_model_account_loaded: 'Loaded {n} models of your account.',
  ai_model_account_failed: 'Could not load your account\'s models.',
  ai_model_account_save_first: 'Save this connection first; then your account\'s models can be loaded.',

  ai_model_facts_known: 'Catalog ({source}):',
  ai_model_facts_alias: 'Looks like {id} in the catalog ({source}), but the Hub does not plan or price from it.',
  ai_model_badge_context: '{size} context',
  ai_model_badge_context_limited: '{size} context, {input} input at most',
  ai_model_badge_price: '{price} per 1M tokens',
  ai_model_badge_tiered: 'tiered price',
  ai_model_badge_think: 'thinks',
  ai_model_badge_tools: 'tools',
  ai_model_badge_vision: 'reads images',
  ai_model_badge_account: 'in your account',
  ai_model_status_alpha: 'alpha',
  ai_model_status_beta: 'beta',
  ai_model_status_deprecated: 'deprecated',
  ai_model_status_not_stable: 'not stable',

  ai_catalog_title: 'The Hub\'s list of models',
  ai_catalog_line: '{label} · {source} · {age} · {models} models',
  ai_catalog_source_bundled: 'ships with the Hub',
  ai_catalog_source_refreshed: 'updated by you',
  ai_catalog_age_today: 'today',
  ai_catalog_age_one: '1 day old',
  ai_catalog_age_other: '{n} days old',
  ai_catalog_update: 'Update from models.dev',
  ai_catalog_updating: 'Updating…',
  ai_catalog_privacy: 'Only when you press it: the Hub downloads one public list from models.dev. It sends no API key, project or content of yours. If anything fails, the list in use stays.',
  ai_catalog_updated: 'Model list updated: {label} ({models} models).',
  ai_catalog_failed: 'The model list could not be updated: {error} The list in use is unchanged.',
  ai_catalog_ignored: 'The Hub ignored the list saved in its data folder ({reason}) and uses the one that ships with it.',
  ai_catalog_ignored_damaged: 'the file is damaged',
  ai_catalog_ignored_older: 'older than the one that ships',
  ai_catalog_ignored_future: 'dated in the future',
};

addTranslations(modelsVi, modelsEn);
