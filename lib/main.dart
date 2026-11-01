import 'dart:convert';
import 'dart:math';
import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

// الرابط بيتم تمريره وقت البناء من GitHub Secret باسم API_URL
const apiUrl = String.fromEnvironment('API_URL');

const labels = {
  'id': 'الكود (لا يتكرر)', 'name': 'الاسم', 'lat': 'خط العرض', 'lng': 'خط الطول',
  'radius': 'النطاق (متر)', 'start': 'بداية الدوام (09:00)', 'end': 'نهاية الدوام (17:00)',
  'hours': 'عدد ساعات العمل', 'grace': 'فترة السماح (دقيقة)', 'code': 'كود الموظف',
  'password': 'كلمة المرور (فاضي = بدون تغيير)', 'branchId': 'كود الفرع', 'shiftId': 'كود الشيفت',
  'salary': 'الراتب الأساسي', 'role': 'الصلاحية (employee / admin)',
  'deviceId': 'الجهاز (امسحه لربط جهاز جديد)', 'active': 'نشط (1 / 0)', 'email': 'الإيميل',
  'key': 'الإعداد', 'value': 'القيمة',
};

class Api {
  static String code = '', pass = '', device = '';
  static Future<Map<String, dynamic>> call(String action, [Map<String, dynamic>? extra]) async {
    final body = jsonEncode({'action': action, 'code': code, 'password': pass, 'deviceId': device, ...?extra});
    var r = await http.post(Uri.parse(apiUrl), headers: {'Content-Type': 'text/plain'}, body: body);
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers['location'] != null) {
      r = await http.get(Uri.parse(r.headers['location']!));
    }
    final j = jsonDecode(utf8.decode(r.bodyBytes));
    if (j['ok'] != true) throw (j['error'] ?? 'حدث خطأ');
    return Map<String, dynamic>.from(j);
  }
}

void snack(BuildContext c, String m, {bool err = false}) {
  ScaffoldMessenger.of(c).showSnackBar(SnackBar(content: Text(m), backgroundColor: err ? Colors.red : Colors.green));
}

Future<void> logout(BuildContext c) async {
  final sp = await SharedPreferences.getInstance();
  await sp.remove('code');
  await sp.remove('pass');
  if (c.mounted) Navigator.pushAndRemoveUntil(c, MaterialPageRoute(builder: (_) => const LoginPage()), (_) => false);
}

void main() => runApp(const App());

class App extends StatelessWidget {
  const App({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
        debugShowCheckedModeBanner: false,
        title: 'حضور وانصراف أسواق بدر',
        theme: ThemeData(useMaterial3: true, colorSchemeSeed: const Color(0xFF05BB62)),
        builder: (c, w) => Directionality(textDirection: TextDirection.rtl, child: w!),
        home: const LoginPage(),
      );
}

/* ============================ تسجيل الدخول ============================ */
class LoginPage extends StatefulWidget {
  const LoginPage({super.key});
  @override
  State<LoginPage> createState() => _LoginState();
}

class _LoginState extends State<LoginPage> {
  final c = TextEditingController(), p = TextEditingController();
  bool busy = false;
  String? err;

  @override
  void initState() {
    super.initState();
    _auto();
  }

  Future<void> _auto() async {
    final sp = await SharedPreferences.getInstance();
    var d = sp.getString('device');
    if (d == null) {
      d = List.generate(24, (_) => Random().nextInt(16).toRadixString(16)).join();
      await sp.setString('device', d);
    }
    Api.device = d;
    final sc = sp.getString('code'), spw = sp.getString('pass');
    if (sc != null && spw != null) {
      c.text = sc;
      p.text = spw;
      _login();
    }
  }

  Future<void> _login() async {
    setState(() { busy = true; err = null; });
    try {
      Api.code = c.text.trim();
      Api.pass = p.text;
      final r = await Api.call('login');
      final sp = await SharedPreferences.getInstance();
      await sp.setString('code', Api.code);
      await sp.setString('pass', Api.pass);
      if (!mounted) return;
      Navigator.pushReplacement(context, MaterialPageRoute(
          builder: (_) => r['role'] == 'admin' ? AdminHome(name: r['name']) : EmployeeHome(info: r)));
    } catch (e) {
      if (mounted) setState(() => err = e.toString());
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        body: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(children: [
              Image.asset('assets/logo.png', height: 200),
              const Text('حضور وانصراف أسواق بدر', style: TextStyle(fontSize: 20, fontWeight: FontWeight.bold, color: Color(0xFF05BB62))),
              const SizedBox(height: 24),
              TextField(controller: c, decoration: const InputDecoration(labelText: 'كود الموظف', border: OutlineInputBorder())),
              const SizedBox(height: 12),
              TextField(controller: p, obscureText: true, decoration: const InputDecoration(labelText: 'كلمة المرور', border: OutlineInputBorder())),
              if (err != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(err!, style: const TextStyle(color: Colors.red))),
              const SizedBox(height: 16),
              SizedBox(width: double.infinity, child: FilledButton(
                  onPressed: busy ? null : _login,
                  child: busy ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('دخول'))),
            ]),
          ),
        ),
      );
}

/* ============================ شاشة الموظف ============================ */
class EmployeeHome extends StatefulWidget {
  final Map info;
  const EmployeeHome({super.key, required this.info});
  @override
  State<EmployeeHome> createState() => _EmpState();
}

class _EmpState extends State<EmployeeHome> {
  late bool open = widget.info['open'] == true;
  bool busy = false;
  DateTime month = DateTime.now();
  Map? data;
  String? err;

  String get ym => '${month.year}-${month.month.toString().padLeft(2, '0')}';

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { data = null; err = null; });
    try {
      final r = await Api.call('month', {'ym': ym});
      if (mounted) setState(() => data = r);
    } catch (e) {
      if (mounted) setState(() => err = e.toString());
    }
  }

  Future<void> _punch() async {
    setState(() => busy = true);
    try {
      var perm = await Geolocator.checkPermission();
      if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
      if (perm == LocationPermission.denied || perm == LocationPermission.deniedForever) {
        throw 'برجاء السماح للتطبيق باستخدام الموقع';
      }
           final pos = await Geolocator.getCurrentPosition(desiredAccuracy: LocationAccuracy.high);
      final r = await Api.call('punch', {
        'type': open ? 'OUT' : 'IN', 'lat': pos.latitude, 'lng': pos.longitude, 'mocked': pos.isMocked});
      open = r['open'] == true;
      if (mounted) snack(context, r['message']);
      _load();
    } catch (e) {
      if (mounted) snack(context, e.toString(), err: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final days = (data?['days'] as List?) ?? [];
    return Scaffold(
      appBar: AppBar(title: Text('أهلاً ${widget.info['name']}'), actions: [
        IconButton(icon: const Icon(Icons.logout), onPressed: () => logout(context))]),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(16),
          child: SizedBox(
            width: double.infinity, height: 64,
            child: FilledButton.icon(
              style: FilledButton.styleFrom(backgroundColor: open ? Colors.deepOrange : Colors.teal),
              onPressed: busy ? null : _punch,
              icon: busy ? const SizedBox(height: 20, width: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white)) : const Icon(Icons.fingerprint),
              label: Text(open ? 'تسجيل انصراف' : 'تسجيل حضور', style: const TextStyle(fontSize: 20)),
            ),
          ),
        ),
        Row(mainAxisAlignment: MainAxisAlignment.center, children: [
          IconButton(icon: const Icon(Icons.chevron_right), onPressed: () { month = DateTime(month.year, month.month - 1); _load(); }),
          Text(ym, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          IconButton(icon: const Icon(Icons.chevron_left), onPressed: () { month = DateTime(month.year, month.month + 1); _load(); }),
        ]),
        if (data != null)
          Card(child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(mainAxisAlignment: MainAxisAlignment.spaceAround, children: [
              _stat('حضور', '${data!['present']}'), _stat('غياب', '${data!['absent']}'),
              _stat('الساعات', '${data!['hours']}'), _stat('إضافي', '${data!['over']}'),
            ]),
          )),
        if (err != null) Padding(padding: const EdgeInsets.all(16), child: Text(err!, style: const TextStyle(color: Colors.red))),
        Expanded(
          child: data == null && err == null
              ? const Center(child: CircularProgressIndicator())
              : ListView.builder(
                  itemCount: days.length,
                  itemBuilder: (_, i) {
                    final d = days[days.length - 1 - i];
                    final st = d['status'];
                    final color = st == 'absent' ? Colors.red : (st == 'off' ? Colors.grey : Colors.teal);
                    return ListTile(
                      leading: Icon(st == 'present' ? Icons.check_circle : (st == 'off' ? Icons.weekend : Icons.cancel), color: color),
                      title: Text('${d['date']}  ${d['dow']}'),
                      subtitle: Text(st == 'present'
                          ? 'حضور ${d['in']}  |  انصراف ${d['out'].toString().isEmpty ? '—' : d['out']}  |  ${d['worked']} س\n${d['note']}'
                          : d['note']),
                      isThreeLine: st == 'present' && d['note'].toString().isNotEmpty,
                    );
                  }),
        ),
      ]),
    );
  }

  Widget _stat(String t, String v) => Column(children: [
        Text(v, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)), Text(t)]);
}

/* ============================ شاشة الـ HR ============================ */
class AdminHome extends StatelessWidget {
  final String name;
  const AdminHome({super.key, required this.name});
  @override
  Widget build(BuildContext context) => DefaultTabController(
        length: 6,
        child: Scaffold(
          appBar: AppBar(
            title: Text('HR أسواق بدر - $name'),
            actions: [IconButton(icon: const Icon(Icons.logout), onPressed: () => logout(context))],
            bottom: const TabBar(isScrollable: true, tabs: [
              Tab(text: 'الموظفين'), Tab(text: 'الفروع'), Tab(text: 'الشيفتات'),
              Tab(text: 'الإيميلات'), Tab(text: 'الإعدادات'), Tab(text: 'التقارير')]),
          ),
          body: const TabBarView(children: [
            ListTab(sheet: 'Employees', t1: 'name', t2: 'code'),
            ListTab(sheet: 'Branches', t1: 'name', t2: 'id'),
            ListTab(sheet: 'Shifts', t1: 'name', t2: 'start'),
            ListTab(sheet: 'Emails', t1: 'email', t2: 'email'),
            ListTab(sheet: 'Settings', t1: 'key', t2: 'value'),
            ReportsTab(),
          ]),
        ),
      );
}

class ListTab extends StatefulWidget {
  final String sheet, t1, t2;
  const ListTab({super.key, required this.sheet, required this.t1, required this.t2});
  @override
  State<ListTab> createState() => _ListState();
}

class _ListState extends State<ListTab> with AutomaticKeepAliveClientMixin {
  List<String> headers = [];
  List<Map> rows = [];
  String? err;
  bool loading = true;
  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() { loading = true; err = null; });
    try {
      final r = await Api.call('adminList', {'sheet': widget.sheet});
      headers = List<String>.from(r['headers']);
      rows = (r['rows'] as List).map((e) => Map<String, dynamic>.from(e)).toList();
    } catch (e) {
      err = e.toString();
    }
    if (mounted) setState(() => loading = false);
  }

  Future<void> _edit([Map? row]) async {
    final isNew = row == null;
    final ctr = {for (final h in headers) h: TextEditingController(text: row?[h]?.toString() ?? '')};
    final res = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        title: Text(isNew ? 'إضافة' : 'تعديل'),
        content: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, children: [
            for (final h in headers)
              TextField(controller: ctr[h], enabled: isNew || h != headers[0], decoration: InputDecoration(labelText: labels[h] ?? h)),
            if (widget.sheet == 'Branches')
              TextButton.icon(
                icon: const Icon(Icons.my_location),
                label: const Text('استخدم موقعي الحالي'),
                onPressed: () async {
                  try {
                    var perm = await Geolocator.checkPermission();
                    if (perm == LocationPermission.denied) perm = await Geolocator.requestPermission();
                    final p = await Geolocator.getCurrentPosition();
                    ctr['lat']!.text = p.latitude.toString();
                    ctr['lng']!.text = p.longitude.toString();
                  } catch (e) {
                    if (mounted) snack(context, 'تعذر تحديد الموقع', err: true);
                  }
                },
              ),
          ]),
        ),
        actions: [
          if (!isNew) TextButton(onPressed: () => Navigator.pop(context, 'del'), child: const Text('حذف', style: TextStyle(color: Colors.red))),
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('إلغاء')),
          FilledButton(onPressed: () => Navigator.pop(context, 'save'), child: const Text('حفظ')),
        ],
      ),
    );
    if (res == null) return;
    try {
      if (res == 'del') {
        await Api.call('adminDelete', {'sheet': widget.sheet, 'key': row![headers[0]]});
      } else {
        await Api.call('adminSave', {'sheet': widget.sheet, 'row': {for (final h in headers) h: ctr[h]!.text.trim()}});
      }
      _load();
    } catch (e) {
      if (mounted) snack(context, e.toString(), err: true);
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return Scaffold(
      floatingActionButton: FloatingActionButton(onPressed: headers.isEmpty ? null : () => _edit(), child: const Icon(Icons.add)),
      body: loading
          ? const Center(child: CircularProgressIndicator())
          : err != null
              ? Center(child: Text(err!, style: const TextStyle(color: Colors.red)))
              : RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(children: [
                    for (final r in rows)
                      ListTile(
                        title: Text('${r[widget.t1]}'),
                        subtitle: widget.t1 == widget.t2 ? null : Text('${r[widget.t2]}'),
                        trailing: const Icon(Icons.edit, size: 18),
                        onTap: () => _edit(r),
                      ),
                    const SizedBox(height: 80),
                  ]),
                ),
    );
  }
}

class ReportsTab extends StatefulWidget {
  const ReportsTab({super.key});
  @override
  State<ReportsTab> createState() => _ReportsState();
}

class _ReportsState extends State<ReportsTab> {
  bool busy = false;

  Future<void> _send(String action, Map<String, dynamic> args) async {
    setState(() => busy = true);
    try {
      final r = await Api.call(action, args);
      if (mounted) snack(context, r['message']);
    } catch (e) {
      if (mounted) snack(context, e.toString(), err: true);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  String _two(int n) => n.toString().padLeft(2, '0');

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(children: [
          const Text('التقرير اليومي يتبعت تلقائياً 6 الصبح، وتقفيل الشهر يوم 1. من هنا تقدر تبعتهم يدوي لأي تاريخ.', textAlign: TextAlign.center),
          const SizedBox(height: 24),
          SizedBox(width: double.infinity, child: FilledButton.icon(
            icon: const Icon(Icons.today),
            label: const Text('إرسال تقرير يوم معين'),
            onPressed: busy ? null : () async {
              final d = await showDatePicker(context: context, initialDate: DateTime.now(), firstDate: DateTime(2024), lastDate: DateTime.now());
              if (d != null) _send('sendDaily', {'date': '${d.year}-${_two(d.month)}-${_two(d.day)}'});
            },
          )),
          const SizedBox(height: 12),
          SizedBox(width: double.infinity, child: FilledButton.icon(
            icon: const Icon(Icons.payments),
            label: const Text('تقفيل شهر + المرتبات (Excel)'),
            onPressed: busy ? null : () async {
              final d = await showDatePicker(context: context, initialDate: DateTime.now(), firstDate: DateTime(2024), lastDate: DateTime.now(), helpText: 'اختر أي يوم في الشهر المطلوب');
              if (d != null) _send('sendMonthly', {'ym': '${d.year}-${_two(d.month)}'});
            },
          )),
          if (busy) const Padding(padding: EdgeInsets.all(24), child: CircularProgressIndicator()),
        ]),
      );
}
