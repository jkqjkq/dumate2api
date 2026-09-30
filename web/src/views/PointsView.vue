<template>
  <div class="page">
    <PageHeader
      :title="isTw ? 'TRAE 额度' : isQw ? '千问积分' : '积分明细'"
      :sub="isTw ? 'TRAE Work 额度与签到（按账号独立）'
        : isQw ? '千问办公积分池与逐笔消耗（真实数据）' : undefined"
    >
      <template #sub>
        <template v-if="isTw">
          TRAE Work 的额度按账号独立 · 与搭子积分、千问积分是三套账
        </template>
        <template v-else-if="isQw">
          千问办公积分池与逐笔消耗 · 经本网关的请求
        </template>
        <template v-else-if="loading">加载中…</template>
        <template v-else-if="current">共 {{ accountOptions.length }} 个账号可选</template>
        <template v-else>没有可用数据</template>
      </template>
      <template #actions>
        <a-button
          size="small"
          class="ghost-btn"
          :loading="loading"
          @click="isTw ? loadTw() : isQw ? loadQw() : load(true)"
        >
          刷新
        </a-button>
      </template>
    </PageHeader>

    <!-- ============ TRAE Work：单一 credits + 签到，与千问三个池子不同 ============ -->
    <template v-if="isTw">
      <a-empty
        v-if="!twRows.length"
        :description="twStatus?.ready ? '还没有 TRAE Work 账号' : (twStatus?.error || '通道不可用')"
      />
      <template v-else>
        <a-row :gutter="[16, 16]">
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="剩余额度合计" :value="twTotals.remain ?? '—'" />
              <div class="text-xs text-slate-500 mt-2">
                <template v-if="twTotals.limit">
                  上限合计 {{ twTotals.limit.toLocaleString('zh-CN') }}
                </template>
                <span v-else>上游未给出额度上限</span>
              </div>
            </a-card>
          </a-col>
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="今日已签到" :value="`${twTotals.checked} / ${twRows.length}`" />
              <div class="text-xs text-slate-500 mt-2">
                签到每日一次，幂等——重复点不会多领
              </div>
            </a-card>
          </a-col>
          <a-col :span="8">
            <a-card :bordered="false" class="h-full">
              <a-statistic title="启用账号" :value="`${twRows.length}`" />
              <div class="text-xs text-slate-500 mt-2">
                额度按账号独立计算，不共享
              </div>
            </a-card>
          </a-col>
        </a-row>

        <a-card title="按账号额度" :bordered="false" class="mt-4">
          <a-table
            size="small"
            :pagination="false"
            :data-source="twRows"
            :columns="twColumns"
            row-key="id"
          >
            <template #bodyCell="{ column, record }">
              <template v-if="column.key === 'name'">
                <div>{{ record.nickname || record.uid || '未命名' }}</div>
                <div class="text-xs text-slate-400 font-mono">UID {{ record.uid || '—' }}</div>
              </template>
              <template v-else-if="column.key === 'remain'">
                <span v-if="record.remain != null" class="font-medium num">
                  {{ record.remain.toLocaleString('zh-CN') }}
                </span>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'limit'">
                <span v-if="record.limit" class="num">{{ record.limit.toLocaleString('zh-CN') }}</span>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'consumed'">
                <span v-if="record.consumed != null" class="num">
                  {{ record.consumed.toLocaleString('zh-CN') }}
                </span>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'checkinCredits'">
                <span v-if="record.checkinCredits != null" class="num">
                  {{ record.checkinCredits.toLocaleString('zh-CN') }}
                </span>
                <span v-else class="text-slate-400">—</span>
                <div v-if="record.checkinExtra" class="text-xs text-slate-400 num">
                  +{{ record.checkinExtra.toLocaleString('zh-CN') }} 额外
                </div>
              </template>
              <template v-else-if="column.key === 'checkin'">
                <a-tag v-if="record.checkedIn == null" color="default">—</a-tag>
                <a-tag v-else :color="record.checkedIn ? 'green' : 'orange'">
                  {{ record.checkedIn ? '已签到' : '未签到' }}
                </a-tag>
              </template>
              <template v-else-if="column.key === 'last'">
                <span v-if="record.lastCheckin" class="text-xs">
                  {{ dateText(record.lastCheckin) }}
                </span>
                <span v-else class="text-slate-400">—</span>
              </template>
              <template v-else-if="column.key === 'err'">
                <span v-if="record.error" class="text-xs text-red-500">{{ record.error }}</span>
                <span v-else class="text-slate-400">—</span>
              </template>
            </template>
          </a-table>
          <div class="text-xs text-slate-400 mt-2">
            「剩余额度」= 额度上限 − 已消耗（上游 usage_summary 的实时值）；
            「签到可得」是今天签到能领到的额度，不是余额。
            取不到时显示 —，不补 0——0 会被读成「额度用完了」。
          </div>
        </a-card>
      </template>
    </template>

    <!-- ============ 千问办公积分：三个池子 + 逐笔消耗 ============ -->
    <template v-else-if="isQw">
      <a-alert
        v-if="qwCredits && !qwCredits.ok"
        type="error"
        show-icon
        :message="qwCredits.error || '取不到千问积分'"
      />
      <template v-else-if="qwCredits">
        <a-row :gutter="[16, 16]">
          <a-col v-for="w in qwCredits.wallets" :key="w.id" :span="6">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                :title="w.label"
                :value="fmtQw(w.balance)"
                :value-style="w.kind === 'free' ? 'color:#22d3ee' : 'color:#60a5fa'"
              />
              <div class="text-xs text-slate-500 mt-2">
                <a-tag :color="w.kind === 'free' ? 'cyan' : 'blue'">
                  {{ w.kind === 'free' ? '免费' : '付费' }}
                </a-tag>
                <template v-if="w.id === 'daily'">
                  <template v-if="qwCredits.accountCount > 1">{{ qwCredits.accountCount }} 个账号合计 · </template>每日 00:00 重置 · 上限 {{ qwCredits.dailyCap }}
                </template>
                <template v-else-if="w.id === 'monthly'">订阅套餐内</template>
                <template v-else>充值 / 赠送</template>
              </div>
            </a-card>
          </a-col>
          <a-col :span="6">
            <a-card :bordered="false" class="h-full">
              <a-statistic
                title="今日消耗"
                :value="fmtQw(qwCredits.today.total)"
                value-style="color:#fbbf24"
              />
              <div class="text-xs text-slate-500 mt-2">
                免费 {{ fmtQw(qwCredits.today.free) }} · 付费 {{ fmtQw(qwCredits.today.paid) }} ·
                {{ qwCredits.today.requests }} 次
              </div>
            </a-card>
          </a-col>
        </a-row>

        <!-- 两套口径分开写：经网关的 vs 全部（含客户端内对话） -->
        <a-alert type="info" show-icon class="mt-4">
          <template #message>两套口径，<b>不要相加</b></template>
          <template #description>
            <div>
              「今日消耗（经本网关）」= {{ fmtQw(qwCredits.today.total) }}
              —— 只统计经过本网关转发的请求。
            </div>
            <div v-if="qwCredits.freeUsed != null">
              「今日全部消耗」= {{ fmtQw(qwCredits.freeUsed) }}
              —— 上限减余额得出，含在千问客户端 / 网页里直接对话的部分。
              <span class="text-slate-400">
                （上限 {{ fmtQw(qwCredits.limit) }}，来源：
                {{ qwCredits.limitSource === 'observed' ? '观测峰值' : '配置兜底' }}）
              </span>
            </div>
            <!-- 未校准（有账号没观测到满额状态）时不给数字：差值会变成
                 「配置上限 − 当前余额」，余额被扣穿时会算出编造值。
                 后端此时返回 null，这里如实说明推不出来。 -->
            <div v-else>
              「今日全部消耗」= <span class="text-slate-400">无法推算</span>
              —— 尚有账号未观测到满额状态，上限只能取配置值，差值不可信。
            </div>
            <div v-if="qwCredits.failedAccounts > 0" class="text-orange-500">
              注意：{{ qwCredits.failedAccounts }} 个账号余额查询失败，上面各池合计
              只含查询成功的 {{ qwCredits.accountCount }} 个账号。
            </div>
          </template>
        </a-alert>
      </template>

      <!-- 逐笔消耗：来自积分归因（按 req_id 与请求日志配对） -->
      <a-card title="逐笔消耗" :bordered="false" class="mt-4">
        <template #extra>
          <span class="text-xs text-slate-400">
            最近 {{ qwRecords.length }} 条 · 合计 {{ fmtQw(qwWindow.total) }}
          </span>
        </template>
        <a-empty v-if="!qwRecords.length" description="还没有经网关的积分记录" />
        <a-table
          v-else
          size="small"
          :data-source="qwRecords"
          :columns="qwRecordColumns"
          row-key="req_id"
          :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false }"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'ts'">
              <span class="text-xs">{{ dateTimeText(record.ts) }}</span>
            </template>
            <template v-else-if="column.key === 'model'">
              <span class="font-mono text-xs">{{ record.model }}</span>
            </template>
            <template v-else-if="column.key === 'pool'">
              <a-tag :color="record.pool === 'daily' ? 'cyan' : (record.pool === 'paid' ? 'blue' : 'default')">
                {{ poolText(record.pool) }}
              </a-tag>
            </template>
            <template v-else-if="column.key === 'free'">
              <span class="text-cyan-500">{{ fmtQw(record.free) }}</span>
            </template>
            <template v-else-if="column.key === 'paid'">
              <span class="text-blue-500">{{ fmtQw(record.paid) }}</span>
            </template>
            <template v-else-if="column.key === 'total'">
              <span class="font-medium">{{ fmtQw(record.total) }}</span>
              <a-tooltip v-if="record.concurrent" title="与相邻请求并发，差值可能含其它请求的消耗">
                <a-tag color="orange" class="ml-1">并发</a-tag>
              </a-tooltip>
            </template>
            <template v-else-if="column.key === 'balance'">
              <span v-if="record.balance" class="text-xs text-slate-400">
                日 {{ fmtQw(record.balance.daily) }} · 月 {{ fmtQw(record.balance.monthly) }} · 长 {{ fmtQw(record.balance.longterm) }}
              </span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'account'">
              <span v-if="record.account" class="text-xs">{{ record.account.name }}</span>
              <span v-else class="text-xs text-slate-400">—</span>
            </template>
          </template>
        </a-table>
      </a-card>
    </template>

    <!-- ============ 百度搭子：原有页面 ============ -->
    <template v-else>
    <!-- 多账号总览：账号管理里添加的每份网页凭证都能独立查积分。
         点行即切换下方明细，避免「看汇总」和「看明细」要操作两次。 -->
    <a-card title="多账号总览" :bordered="false" class="mb-4">
      <template v-if="allPoints && allPoints.accounts.length">
        <a-row :gutter="[16, 16]" class="mb-3">
          <a-col :span="8">
            <a-statistic
              title="账号总余额"
              :value="allPoints.totals.left"
              :precision="2"
            />
            <div class="text-xs text-slate-500 mt-2">
              {{ allPoints.totals.ok_accounts }} / {{ allPoints.totals.accounts }} 个账号取到数据
            </div>
          </a-col>
          <a-col :span="8">
            <a-statistic title="账号总量" :value="allPoints.totals.total" :precision="2" />
          </a-col>
          <a-col :span="8">
            <a-statistic title="账号已用" :value="allPoints.totals.used" :precision="2" />
          </a-col>
        </a-row>

        <a-table
          size="small"
          :pagination="false"
          :data-source="allPoints.accounts"
          :columns="acctColumns"
          row-key="id"
          :row-class-name="rowClass"
          :custom-row="customRow"
        >
          <template #bodyCell="{ column, record }">
            <template v-if="column.key === 'name'">
              <div>{{ record.name }}</div>
              <div v-if="!record.ok" class="text-xs text-red-500">{{ record.error }}</div>
            </template>
            <template v-else-if="column.key === 'left'">
              <span v-if="record.ok" class="font-medium">{{ fmt(record.left) }}</span>
              <span v-else class="text-slate-400">—</span>
            </template>
            <template v-else-if="column.key === 'total'">
              {{ record.ok ? fmt(record.total) : '—' }}
            </template>
            <template v-else-if="column.key === 'used'">
              {{ record.ok ? fmt(record.used) : '—' }}
            </template>
            <template v-else-if="column.key === 'state'">
              <a-tag v-if="!record.ok" color="red">失效</a-tag>
              <a-tag v-else-if="record.throttled" color="orange">限流</a-tag>
              <a-tag v-else color="green">正常</a-tag>
            </template>
          </template>
        </a-table>
      </template>
      <a-empty v-else description="还没有添加账号。到「账号管理」里添加后，这里会显示每个账号的积分。" />
    </a-card>

    <!-- 账号切换：下面所有区块都跟随这里选中的账号。
         原先只有一个小 radio 组，切了之后下方变化不明显，容易被读成「没切换成功」，
         所以改成大号分段控件 + 顶部大标题，并把选中行在总览表里同步高亮。 -->
    <a-card :bordered="false" class="mb-4">
      <template #title>
        <span class="text-base font-medium">查看账号</span>
      </template>
      <template #extra>
        <span v-if="detailCached" class="text-xs text-slate-400">本次为缓存数据</span>
      </template>

      <a-radio-group
        v-model:value="selectedId"
        button-style="solid"
        size="large"
        class="w-full flex"
      >
        <a-radio-button
          v-for="o in accountOptions"
          :key="o.key"
          :value="o.key"
          :disabled="!o.ok"
          class="acct-btn flex-1 text-center"
        >
          {{ o.label }}
          <span v-if="!o.ok" class="text-xs opacity-70">（不可用）</span>
        </a-radio-button>
      </a-radio-group>

      <div class="text-xs text-slate-500 mt-2">
        切换账号不会重新请求——每个账号的完整明细已随列表一次性取回。点「刷新」才重新打上游。
      </div>
    </a-card>

    <!-- 当前账号大标题：切换后最先看到的反馈 -->
    <div
      v-if="current"
      class="acct-banner mb-4 flex items-center justify-between flex-wrap gap-2"
    >
      <div class="flex items-center gap-3">
        <span class="text-xs text-slate-500">当前查看</span>
        <span class="text-xl font-semibold text-slate-800">{{ currentLabel }}</span>
        <a-tag v-if="selectedId === 'local'" color="blue">桌面凭证</a-tag>
        <a-tag v-else color="purple">网页凭证</a-tag>
      </div>
      <div class="text-sm text-slate-600">
        余额 <b class="text-base">{{ fmt(current.left) }}</b>
        <span class="text-slate-400 ml-2">共 {{ fmt(current.total) }} · 已用 {{ fmt(current.used) }}</span>
      </div>
    </div>

    <div v-if="!accountOptions.length" class="text-xs text-slate-500 mb-2">
      还没有添加网页账号。到「账号管理」里添加后，可与本地后端账号一起切换查看。
    </div>

    <a-alert v-if="currentError" type="warning" show-icon class="mb-4" :message="`积分获取失败：${currentError}`" />

    <!-- 明细区按账号 key 化：切换时整块重新挂载并淡入，视觉上能确认「换了一份数据」 -->
    <div :key="selectedId" class="detail-block">

    <a-row :gutter="[16, 16]">
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="可用余额" :value="current?.left ?? '—'" :precision="2" />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="current">共 {{ fmt(current.total) }} · 已用 {{ fmt(current.used) }}</template>
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic title="额度包数量" :value="current?.packages?.length ?? '—'" />
          <div class="text-xs text-slate-500 mt-2">订阅 + 增量包</div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic
            title="即将过期"
            :value="current ? (current.expiring?.length ?? 0) : '—'"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="current?.expiring?.length">
              最近 {{ dateText(current.expiring[0].expire_at) }}
            </template>
            <span v-else>没有未用完且临期的额度</span>
          </div>
        </a-card>
      </a-col>
      <a-col :span="6">
        <a-card :bordered="false">
          <a-statistic
            title="已过期未用完"
            :value="current ? (current.expired_unused?.length ?? 0) : '—'"
          />
          <div class="text-xs text-slate-500 mt-2">
            <template v-if="current?.expired_unused?.length">
              这部分额度已经用不上了
            </template>
            <span v-else>没有浪费的额度</span>
          </div>
        </a-card>
      </a-col>
    </a-row>

    <a-card title="按来源统计" :bordered="false" class="mt-4">
      <a-alert
        type="info"
        show-icon
        class="mb-3"
        message="积分由服务端按天自动发放，没有签到或任务领取接口"
        description="登录奖励（login_bonus）为每日自动发放 500，成长计划奖励（growth_plan_*）由服务端按账号状态发放。客户端只提供查询接口，无手动领取能力。"
      />
      <a-table
        size="small"
        :pagination="false"
        :data-source="current?.sources ?? []"
        :columns="sourceColumns"
        row-key="source"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            <span class="font-mono text-xs">{{ record.source }}</span>
          </template>
          <template v-else-if="column.key === 'num'">
            {{ fmt(record.total) }}
          </template>
          <template v-else-if="column.key === 'used'">
            {{ fmt(record.used) }}
          </template>
          <template v-else-if="column.key === 'left'">
            <span class="font-medium">{{ fmt(record.left) }}</span>
          </template>
          <template v-else-if="column.key === 'last'">
            <template v-if="record.last_at">
              {{ dateText(record.last_at) }}
              <a-tag :color="record.days_since_last === 0 ? 'green' : record.days_since_last > 3 ? 'orange' : 'default'" class="ml-1">
                {{ record.days_since_last === 0 ? '今天' : record.days_since_last + ' 天前' }}
              </a-tag>
            </template>
            <span v-else>—</span>
          </template>
        </template>
      </a-table>
    </a-card>

    <a-card title="每日发放与消耗" :bordered="false" class="mt-4">
      <a-empty v-if="!current?.daily_grant?.length" description="没有发放记录" />
      <!-- 发放与消耗同为「积分」量纲，所以能共图共用一张 Y 轴；
           先前手写的柱状图只画了发放，消耗藏在 title 里要悬停才看得到，
           而「发了多少、用了多少」恰恰是这张图要回答的。 -->
      <div v-else ref="grantChartEl" class="grant-chart" />
    </a-card>

    <a-card title="逐笔发放记录" :bordered="false" class="mt-4">
      <a-table
        size="small"
        :data-source="pkgRows"
        :columns="pkgColumns"
        row-key="rowKey"
        :pagination="{ pageSize: 15, size: 'small', showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'source'">
            <span class="font-mono text-xs">{{ record.source || record.package_type || '—' }}</span>
          </template>
          <template v-else-if="column.key === 'granted'">
            {{ dateTimeText(record.granted_at) }}
          </template>
          <template v-else-if="column.key === 'expire'">
            {{ dateTimeText(record.expire_at) }}
          </template>
          <template v-else-if="column.key === 'total'">
            {{ fmt(record.total) }}
          </template>
          <template v-else-if="column.key === 'used'">
            {{ fmt(record.used) }}
          </template>
          <template v-else-if="column.key === 'left'">
            <a-tag :color="record.left > 0 ? 'green' : 'default'">{{ fmt(record.left) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'status'">
            <a-tag :color="pkgStateColor(record)">{{ pkgStateText(record) }}</a-tag>
          </template>
        </template>
      </a-table>
    </a-card>
    </div>

    <!-- ============ 操作流水（签到 / 任务 / 抽奖 / 自动发放）============
         原来这是独立的「任务记录」页。并入积分明细的理由：这些动作**全都是
         积分的来源**，而本页其余区块（额度包、按来源、每日发放、逐笔发放）
         回答的是同一个问题——「积分从哪来、怎么没的」。拆成两页会让
         「查一笔积分的来历」要在两页之间来回跳。
         账号管理页保留的是**操作台**（增删账号、跑任务、开轮询），
         记录是结果，不该堆在操作台上。 -->
    <a-card title="签到日历" :bordered="false" class="mt-4">
      <template #extra>
        <span class="text-xs text-slate-400">已签日来自上游 sign_in_days，是权威数据</span>
      </template>
      <a-spin :spinning="calLoading">
        <a-alert v-if="calError" type="error" show-icon :message="calError" class="mb-2" />
        <a-empty v-else-if="!calendar?.accounts?.length" description="还没有账号" />
        <div v-for="a in calendar?.accounts ?? []" :key="a.account_id" class="mb-4">
          <div class="flex items-center justify-between mb-2">
            <div>
              <span class="font-medium">{{ a.name }}</span>
              <a-tag :color="a.has_issued_today ? 'green' : 'orange'" class="ml-2">
                {{ a.has_issued_today ? '今日已签' : '今日未签' }}
              </a-tag>
              <span class="text-xs text-slate-500 ml-2">
                累计 {{ a.total_times ?? '—' }} 次 · 本月 {{ a.sign_in_days.length }} 天
              </span>
            </div>
            <a-tag v-if="!a.ok" color="red">{{ a.error }}</a-tag>
          </div>
          <div class="flex flex-wrap gap-1">
            <a-tag
              v-for="d in monthDays(a)"
              :key="d.day"
              :color="d.signed ? 'green' : d.isToday ? 'blue' : 'default'"
              :title="d.day"
            >
              {{ d.label }}
            </a-tag>
          </div>
        </div>
      </a-spin>
    </a-card>

    <a-card title="操作流水" :bordered="false" class="mt-4">
      <template #extra>
        <a-space>
          <a-select v-model:value="opType" size="small" style="width: 110px" :options="opTypeOptions" />
          <a-select v-model:value="opAccount" size="small" style="width: 140px" :options="opAccountOptions" />
          <a-select v-model:value="opDays" size="small" style="width: 100px" :options="opDayOptions" />
          <a-button size="small" class="ghost-btn" :loading="opLoading" @click="loadOps">刷新</a-button>
        </a-space>
      </template>

      <!-- 按天聚合：一眼看出哪天做了什么。只标类型不显示次数——
           「哪天做过什么」是这张表要回答的，次数在下面明细里能数。 -->
      <a-alert v-if="opError" type="error" show-icon :message="opError" class="mb-2" />
      <a-empty v-else-if="!ops?.daily?.length" description="还没有操作记录" />
      <a-table
        v-else
        size="small"
        :pagination="false"
        :data-source="ops.daily"
        :columns="opDailyColumns"
        row-key="account_id"
        class="mb-4"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'name'">{{ record.account }}</template>
          <template v-else-if="column.key === 'days'">
            <div v-for="(acts, day) in record.days" :key="day" class="text-xs leading-5">
              <span class="text-slate-400">{{ day }}</span>
              <a-tag v-for="(_, t) in acts" :key="t" :color="opTypeColor(String(t))" class="ml-1">
                {{ opTypeText(String(t)) }}
              </a-tag>
            </div>
          </template>
        </template>
      </a-table>

      <a-table
        size="small"
        :data-source="ops?.rows ?? []"
        :columns="opColumns"
        row-key="rowKey"
        :pagination="{ pageSize: 20, size: 'small', showSizeChanger: false }"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'ts'">
            <!-- 自动发放显示真实发放时刻（服务端 00:00 发的），不是「我们查到的时刻」
                 ——否则会看起来像点签到才发的 -->
            <span class="text-xs">
              {{ dateTimeText(record.type === 'grant' && record.granted_at ? record.granted_at : record.ts) }}
            </span>
          </template>
          <template v-else-if="column.key === 'type'">
            <a-tag :color="opTypeColor(record.type)">{{ opTypeText(record.type) }}</a-tag>
          </template>
          <template v-else-if="column.key === 'account'">{{ record.account }}</template>
          <template v-else-if="column.key === 'detail'">
            <template v-if="record.type === 'checkin'">
              {{ opCheckinText(record.result) }}
              <a-tag v-if="!record.ok" color="red" class="ml-1">失败</a-tag>
              <span v-if="record.error" class="text-xs text-red-500 ml-1">{{ record.error }}</span>
            </template>
            <template v-else-if="record.type === 'task'">
              {{ record.title }}
              <a-tag v-if="record.already" color="default" class="ml-1">已发放</a-tag>
              <a-tag v-if="!record.ok" color="red" class="ml-1">失败</a-tag>
              <span v-if="record.error" class="text-xs text-red-500 ml-1">{{ record.error }}</span>
              <div class="text-xs text-slate-400 mt-1">
                <span v-if="record.via === 'query-then-complete'">发消息+上报</span>
                <span v-else-if="record.via === 'complete-only'">仅上报</span>
                <span v-else-if="record.via === 'noop'">无事可做</span>
                <template v-if="record.ms != null">
                  <span class="mx-1">·</span>耗时 {{ fmtMs(record.ms) }}
                </template>
                <template v-if="record.expected_points">
                  <span class="mx-1">·</span>声明奖励 {{ record.expected_points }} 积分
                </template>
              </div>
            </template>
            <template v-else-if="record.type === 'draw'">
              <template v-if="record.prize">抽到 <span class="font-medium">{{ record.prize }}</span></template>
              <template v-else>抽了 {{ record.count || 1 }} 次</template>
            </template>
            <template v-else-if="record.type === 'grant'">
              登录奖励 <span class="font-medium">+{{ record.points_delta }}</span>
              <a-tag color="blue" class="ml-1">自动</a-tag>
              <span class="text-xs text-slate-400 ml-1">{{ record.note }}</span>
            </template>
          </template>
          <template v-else-if="column.key === 'points'">
            <template v-if="record.points_delta !== null && record.points_delta !== undefined">
              <span :class="record.points_delta > 0 ? 'text-green-600' : 'text-slate-400'">
                余额 {{ record.points_delta > 0 ? '+' + record.points_delta : record.points_delta }}
                <span v-if="record.points_before !== null && record.points_after !== null" class="text-xs text-slate-400">
                  ({{ fmt(record.points_before) }} → {{ fmt(record.points_after) }})
                </span>
              </span>
            </template>
            <!-- 没有 delta 与「delta 为 0」是两回事：前者是没打发放接口（今日已签），
                 后者才是真发了但没增加。如实显示 —，不折成 0。 -->
            <span v-else class="text-slate-400">— <span class="text-xs">本次未发放</span></span>
          </template>
        </template>
      </a-table>
    </a-card>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, LegendComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import PageHeader from '@/components/PageHeader.vue'
import client from '@/api/client'
import { channelStore, isTraework, isQwenwork } from '@/stores/channel'
import { traeworkApi } from '@/api/traework'
import type { TraeworkCreditRow, TraeworkStatus } from '@/api/traework'
import { qwenworkApi } from '@/api/qwenwork'
import type { QwCredits, QwCreditRecord } from '@/api/qwenwork'
import type { PointsData, PointsPackage, AllPointsData, AccountPoints } from '@/api/points'
import type { RecordsData, CheckinCalendarData } from '@/api/records'
import { SERIES, INK, TOOLTIP_BASE, axisStyle, compactNum, exactNum, barSeries } from '@/utils/chartTheme'

echarts.use([BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer])

// 当前展示的账号统一成一份「明细视图」：本地后端与网页账号字段对齐后，
// 下面的统计卡 / 按来源 / 每日发放 / 逐笔四块都只读它，切换账号时整套跟着变。
interface PointsView2 {
  left: number
  total: number
  used: number
  packages: PointsPackage[]
  expiring: PointsPackage[]
  expired_unused: PointsPackage[]
  sources: any[]
  daily_grant: any[]
}

const data = ref<PointsData | null>(null)
const allPoints = ref<AllPointsData | null>(null)
const loading = ref(false)
const error = ref('')
const selectedId = ref<string>('local')

// TRAE Work 的额度：单一 credits，按账号独立，靠签到领取。
// 与千问的「三个积分池」是两套账，不合并显示。
const isTw = computed(() => isTraework())
const twStatus = ref<TraeworkStatus | null>(null)
const twRows = ref<TraeworkCreditRow[]>([])

const twColumns = [
  { title: '账号', key: 'name', width: '20%' },
  { title: '剩余额度', key: 'remain', width: '13%' },
  { title: '额度上限', key: 'limit', width: '13%' },
  { title: '已消耗', key: 'consumed', width: '13%' },
  { title: '签到可得', key: 'checkinCredits', width: '13%' },
  { title: '今日签到', key: 'checkin', width: '12%' },
  { title: '上次签到', key: 'last', width: '16%' },
  { title: '错误', key: 'err' },
]

// 合计只对**取到值**的账号求和：把 null 当 0 会让「一个账号取不到」
// 表现成「总额度变少了」，而真相是没测到
const twTotals = computed(() => {
  let remain = 0
  let limit = 0
  let checked = 0
  let anyRemain = false
  let anyLimit = false
  for (const r of twRows.value) {
    if (r.remain != null) { remain += r.remain; anyRemain = true }
    if (r.limit != null) { limit += r.limit; anyLimit = true }
    if (r.checkedIn) checked++
  }
  return {
    remain: anyRemain ? remain : null,
    limit: anyLimit ? limit : null,
    checked,
  }
})

async function loadTw() {
  loading.value = true
  try {
    const [s, c] = await Promise.all([
      traeworkApi.status().catch((e: any) => ({
        data: { ready: false, error: e?.message || '读取失败', accounts: 0, mode: 'multi', modeNote: '', rows: [] },
      })),
      traeworkApi.credits().catch(() => ({ data: { count: 0, rows: [] } })),
    ])
    twStatus.value = s.data as TraeworkStatus
    twRows.value = c.data.rows || []
  } finally {
    loading.value = false
  }
}

// ---- 千问办公积分（与搭子、TRAE 都是两套账）----
const isQw = computed(() => isQwenwork())
const qwCredits = ref<QwCredits | null>(null)
const qwRecords = ref<QwCreditRecord[]>([])
const qwWindow = ref({ free: 0, paid: 0, total: 0, requests: 0 })

const qwRecordColumns = [
  { title: '时间', key: 'ts', width: '17%' },
  { title: '模型', key: 'model', width: '12%' },
  { title: '扣费池', key: 'pool', width: '10%' },
  { title: '免费', key: 'free', width: '11%' },
  { title: '付费', key: 'paid', width: '11%' },
  { title: '合计', key: 'total', width: '13%' },
  { title: '请求后余额', key: 'balance', width: '16%' },
  { title: '账号', key: 'account', width: '10%' },
]

const poolText = (p: string) =>
  p === 'daily' ? '每日免费' : p === 'paid' ? '付费积分' : p === 'none' ? '未扣费' : '—'

// ---- 操作流水（签到 / 任务 / 抽奖 / 自动发放）----
// 原来是一个独立的「任务记录」页，并入本页的理由见模板里的注释。
// 数据是搭子网页端（dumate.baidu.com）的，与千问/TRAE 无关，所以只在搭子分支渲染。
const ops = ref<RecordsData | null>(null)
const calendar = ref<CheckinCalendarData | null>(null)
const opLoading = ref(false)
const calLoading = ref(false)
// 拉取失败与「确实没有记录」必须分开：前者是故障，后者是正常空态。
// 折成一个空态等于把一次失败断言成「确实没签到过」。
const opError = ref('')
const calError = ref('')
const opType = ref('')
const opAccount = ref<number | null>(null)
const opDays = ref(30)

const opTypeOptions = [
  { label: '全部类型', value: '' },
  { label: '签到', value: 'checkin' },
  { label: '任务', value: 'task' },
  { label: '抽奖', value: 'draw' },
  { label: '自动发放', value: 'grant' },
]
const opDayOptions = [
  { label: '近 7 天', value: 7 },
  { label: '近 30 天', value: 30 },
  { label: '近 90 天', value: 90 },
]
const opAccountOptions = ref<Array<{ label: string; value: number | null }>>([
  { label: '全部账号', value: null },
])
const opDailyColumns = [
  { title: '账号', key: 'name', width: '20%' },
  { title: '按天', key: 'days' },
]
const opColumns = [
  { title: '时间', key: 'ts', width: '16%' },
  { title: '类型', key: 'type', width: '9%' },
  { title: '账号', key: 'account', width: '14%' },
  { title: '结果', key: 'detail' },
  { title: '积分', key: 'points', width: '19%' },
]

const opTypeText = (t: string) => ops.value?.types?.[t] || t
const opTypeColor = (t: string) =>
  t === 'checkin' ? 'green' : t === 'task' ? 'blue' : t === 'draw' ? 'orange'
    : t === 'grant' ? 'cyan' : 'default'
// 任务耗时：秒/毫秒自动切换
const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)

// 「今日已签」不等于这次发了分：签到是幂等的，已签就不再打发放接口，
// 所以这行没有本次发放金额。当天额度通常已由服务端在 00:00 自动发过，
// 那份属于当天早些时候的发放，不记在这次调用头上。
function opCheckinText(r?: string) {
  return r === 'claimed' ? '签到成功'
    : r === 'already' ? '今日已签（本次未发放）'
    : r === 'failed' ? '签到失败' : '—'
}

// 本月逐日：已签来自上游 sign_in_days，今天单独标色
function monthDays(a: { sign_in_days: string[] }) {
  const signed = new Set(a.sign_in_days)
  const now = new Date()
  const key = (d: number) =>
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  const todayKey = key(now.getDate())
  const out = []
  for (let d = 1; d <= now.getDate(); d++) {
    out.push({ day: key(d), label: String(d), signed: signed.has(key(d)), isToday: key(d) === todayKey })
  }
  return out
}

async function loadOps() {
  opLoading.value = true
  opError.value = ''
  try {
    const params = new URLSearchParams()
    if (opType.value) params.set('type', opType.value)
    if (opAccount.value) params.set('account_id', String(opAccount.value))
    params.set('days', String(opDays.value))
    params.set('limit', '500')
    const { data } = await client.get(`/web-accounts/records?${params}`)
    // rowKey：ts 可能撞（同一毫秒多条），补上类型与序号
    ops.value = {
      ...data,
      rows: (data.rows || []).map((r: any, i: number) => ({ ...r, rowKey: `${r.ts}-${r.type}-${i}` })),
    }
  } catch (e: any) {
    // 取不到要如实说「拉取失败」，不能渲染成「还没有操作记录」——
    // 那是把一次失败断言成「确实没签到过」，用户会据此以为账号没问题
    opError.value = e?.response?.data?.error || e?.message || '操作流水加载失败'
    ops.value = null
  } finally {
    opLoading.value = false
  }
}

/**
 * 账号筛选选项**独立拉取**，不从记录里反推。
 *
 * 原来是从 /records 的 daily 里补全，且只在 `length===1 && daily?.length`
 * 时填一次。两个后果：首次响应没有记录（默认 30 天窗口内无活动）就永远
 * 停在「全部账号」；窗口外有记录的账号也选不到。账号列表本来就有一个
 * 现成接口，直接用它更准也更简单。
 */
async function loadOpAccounts() {
  try {
    const { data } = await client.get('/web-accounts')
    opAccountOptions.value = [
      { label: '全部账号', value: null },
      ...(data.accounts || []).map((a: any) => ({ label: a.name, value: a.id })),
    ]
  } catch (e) { /* 取不到就保持「全部账号」，不影响主列表 */ }
}

async function loadCalendar() {
  calLoading.value = true
  calError.value = ''
  try {
    const { data } = await client.get('/web-accounts/checkin-calendar')
    calendar.value = data
  } catch (e: any) {
    // 同上：拉取失败与「没有账号」是两回事
    calError.value = e?.response?.data?.error || e?.message || '签到日历加载失败'
    calendar.value = null
  } finally {
    calLoading.value = false
  }
}

async function loadQw() {
  loading.value = true
  try {
    const [credits, records] = await Promise.all([
      qwenworkApi.credits().catch((e: any) => ({ data: { ok: false, error: e?.message || '取不到千问积分' } })),
      qwenworkApi.creditRecords(200).catch(() => ({ data: { rows: [], window: { free: 0, paid: 0, total: 0, requests: 0 } } })),
    ])
    qwCredits.value = credits.data as QwCredits
    qwRecords.value = records.data.rows || []
    qwWindow.value = records.data.window || { free: 0, paid: 0, total: 0, requests: 0 }
  } finally {
    loading.value = false
  }
}

// 可切换的账号：本地后端 + 每个网页账号。取不到数据的也列出来（禁用），
// 否则用户不知道自己有这个账号、只是这次查询失败了。
const accountOptions = computed(() => {
  const opts: Array<{ key: string; label: string; ok: boolean }> = []
  for (const a of allPoints.value?.accounts ?? []) {
    opts.push({ key: String(a.id), label: a.name, ok: !!a.ok })
  }
  opts.push({ key: 'local', label: data.value?.account_name || '本地后端', ok: !!data.value })
  return opts
})

// 选中的账号明细。网页账号的 id 是数字，本地后端固定 'local'。
const current = computed<PointsView2 | null>(() => {
  if (selectedId.value === 'local') {
    const d = data.value
    if (!d) return null
    return {
      left: d.left, total: d.total, used: d.used,
      packages: d.packages, expiring: d.expiring,
      expired_unused: d.expired_unused, sources: d.sources, daily_grant: d.daily_grant,
    }
  }
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  if (!a || !a.ok) return null
  return {
    left: a.left ?? 0, total: a.total ?? 0, used: a.used ?? 0,
    packages: a.packages ?? [], expiring: a.expiring ?? [],
    expired_unused: a.expired_unused ?? [], sources: a.sources ?? [], daily_grant: a.daily_grant ?? [],
  }
})

// 当前选中的账号查询失败时，把原因显示在当前位置而不是顶部——顶部那一条
// 是留给整体加载失败的，两个来源的错误不该混在一起
const currentError = computed(() => {
  if (selectedId.value === 'local') return error.value
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  return a && !a.ok ? (a.error || '查询失败') : ''
})

const detailCached = computed(() => {
  if (selectedId.value === 'local') return !!data.value?.cached
  const a = (allPoints.value?.accounts ?? []).find((x) => String(x.id) === selectedId.value)
  return !!a?.cached
})

const currentLabel = computed(() =>
  accountOptions.value.find((o) => o.key === selectedId.value)?.label ?? '—')

// 总览表点行切换下方明细：汇总与明细是同一批账号的两种视图，
// 让用户来回找切换器没有意义
function customRow(record: AccountPoints) {
  return {
    onClick: () => {
      if (record.ok) selectedId.value = String(record.id)
    },
  }
}
function rowClass(record: AccountPoints) {
  return String(record.id) === selectedId.value ? 'row-selected' : ''
}

// 多账号表的列
const acctColumns = [
  { title: '账号', key: 'name' },
  { title: '余额', key: 'left', width: '18%' },
  { title: '总量', key: 'total', width: '16%' },
  { title: '已用', key: 'used', width: '16%' },
  { title: '状态', key: 'state', width: '12%' },
]

const sourceColumns = [
  { title: '来源', key: 'source', width: '26%' },
  { title: '笔数', key: 'count', width: '10%' },
  { title: '发放总额', key: 'num', width: '16%' },
  { title: '已用', key: 'used', width: '16%' },
  { title: '剩余', key: 'left', width: '16%' },
  { title: '最近发放', key: 'last', width: '16%' },
]
const pkgColumns = [
  { title: '来源', key: 'source', width: '22%' },
  { title: '发放时间', key: 'granted', width: '18%' },
  { title: '到期时间', key: 'expire', width: '18%' },
  { title: '总额', key: 'total', width: '12%' },
  { title: '已用', key: 'used', width: '12%' },
  { title: '剩余', key: 'left', width: '10%' },
  { title: '状态', key: 'status', width: '10%' },
]

// 逐笔记录要按发放时间倒序，且补一个稳定的 key（包 ID 可能重复）
const recentDaily = computed(() => (current.value?.daily_grant ?? []).slice(-14))

const pkgRows = computed(() =>
  (current.value?.packages ?? [])
    .slice()
    .sort((a, b) => (b.granted_at || 0) - (a.granted_at || 0))
    .map((p, i) => ({ ...p, rowKey: `${p.source}-${p.granted_at}-${i}` })))

const fmt = (n: number) => n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
// 千问积分保留 4 位：实测单次消耗 0.0025，按 2 位显示会变成 0
const fmtQw = (n: number | null | undefined) =>
  n == null ? '—' : Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 4 })
const dateText = (ts: number | null) =>
  ts ? new Date(ts).toLocaleDateString('zh-CN') : '—'
// 发放/到期时间精确到秒：同一天会发多笔（实测一天 61 笔），只到日期的话
// 逐笔记录里几十行显示完全一样，分不出先后顺序
const dateTimeText = (ts: number | null) =>
  ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'

// 每日发放与消耗。两个序列同量纲（积分），共用一个 Y 轴与图例。
function renderGrantChart() {
  if (!grantChartEl.value) return
  if (!grantChart) grantChart = echarts.init(grantChartEl.value)
  const rows = recentDaily.value
  if (!rows.length) return

  grantChart.setOption({
    grid: { left: 60, right: 12, top: 34, bottom: 26 },
    legend: {
      data: ['发放', '消耗'],
      right: 0,
      top: 0,
      itemWidth: 12,
      itemHeight: 8,
      textStyle: { color: INK.secondary, fontSize: 12 },
    },
    tooltip: {
      ...TOOLTIP_BASE,
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: any[]) => {
        const r = rows[params[0].dataIndex]
        return `<div style="color:${INK.muted};font-size:11px">${r.day}</div>`
          + `<div style="margin-top:2px">发放 <b>${exactNum(r.granted)}</b></div>`
          + `<div>消耗 <b>${exactNum(r.used)}</b></div>`
          + `<div style="color:${INK.muted}">${r.count} 笔</div>`
      },
    },
    xAxis: {
      type: 'category',
      data: rows.map((r) => r.day.slice(5)),
      ...axisStyle({ showGrid: false }),
    },
    yAxis: { type: 'value', ...axisStyle({ formatter: (v: number) => compactNum(v) }) },
    series: [
      barSeries({ name: '发放', data: rows.map((r) => r.granted), color: SERIES[0] }),
      barSeries({ name: '消耗', data: rows.map((r) => r.used), color: SERIES[1] }),
    ],
  })
}

function pkgStateText(p: PointsPackage) {
  if (p.expire_at && p.expire_at < Date.now()) return p.left > 0 ? '已过期(有剩余)' : '已过期'
  if (p.left <= 0) return '已用尽'
  return '可用'
}
function pkgStateColor(p: PointsPackage) {
  if (p.expire_at && p.expire_at < Date.now()) return 'red'
  if (p.left <= 0) return 'default'
  return 'green'
}

async function load(force = false) {
  loading.value = true
  error.value = ''
  try {
    // 多账号（网页凭证）与单账号（本地后端）分别拉：一个失败不影响另一个显示
    try {
      const { data: ap } = await client.get('/web-accounts/points-all' + (force ? '?refresh=1' : ''))
      allPoints.value = ap
    } catch (e) { /* 账号管理没配也不影响下面的明细 */ }

    try {
      const { data: d } = await client.get('/points/points' + (force ? '?refresh=1' : ''))
      data.value = d
    } catch (e: any) {
      // 本地后端起不来时不能把整页判死：网页账号的明细照样要看得到
      error.value = e?.response?.data?.error || e?.message || '未知错误'
    }

    // 首次加载默认选中第一个可用账号（网页账号优先）。之后刷新保留用户选择，
    // 否则每次点刷新都会跳回去，正在对比的账号被切走。
    const valid = accountOptions.value.filter((o) => o.ok).map((o) => o.key)
    if (!valid.includes(selectedId.value)) {
      selectedId.value = valid[0] ?? 'local'
    }
  } finally {
    loading.value = false
  }
}

// 图表实例：切换账号或刷新后要重画，组件卸载要销毁（否则 resize 监听会持有已卸载的实例）
const grantChartEl = ref<HTMLElement | null>(null)
let grantChart: echarts.ECharts | null = null

// 数据或所选账号变化时重画。用 watch 而不是在 load() 里直接调用：
// 切换账号不重新请求，但图必须跟着换。
watch([current, recentDaily], async () => {
  await nextTick()
  renderGrantChart()
}, { deep: false })

function onResize() { grantChart?.resize() }

// 操作流水只在搭子通道有意义（签到/抽奖/任务是网页端独有），
// 千问与 TRAE 各自的账在各自的区块里，切过去时不请求、也不渲染。
watch([opType, opAccount, opDays], () => { if (!isTw.value && !isQw.value) loadOps() })

onMounted(() => {
  // 按当前通道初始化：顶栏已切到 TRAE/千问时进这个页面，
  // 该拉的是对应通道的账，而不是搭子的额度包
  if (isTw.value) loadTw()
  else if (isQw.value) loadQw()
  else {
    load()
    loadOps()
    loadOpAccounts()
    loadCalendar()
  }
  window.addEventListener('resize', onResize)
})

// 切通道重拉：三条通道的数据源与结构都不同
watch(() => channelStore.current, () => {
  if (isTw.value) loadTw()
  else if (isQw.value) loadQw()
  else {
    load()
    loadOps()
    loadOpAccounts()
    loadCalendar()
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize)
  grantChart?.dispose()
  grantChart = null
})
</script>

<style scoped>
/* 高度含 X 轴标签带，避免卡片里出现内嵌滚动条 */
.grant-chart {
  height: 240px;
  width: 100%;
}

/* 选中行给左侧色条 + 底色，让「下方明细属于哪一行」一眼可见 */
:deep(.row-selected) > td {
  background: var(--lab-primary-dim) !important;
}
:deep(.row-selected) > td:first-child {
  box-shadow: inset 3px 0 0 var(--lab-primary);
}

/* 切换按钮加大：默认 solid 按钮太小，点完看不出选中态变化 */
:deep(.acct-btn) {
  min-height: 40px;
  line-height: 38px;
  padding: 0 16px;
  font-size: 14px;
}

/* 当前账号大标题：青色信号条 + 极淡渐变，与侧栏选中态同一套语言 */
.acct-banner {
  background: linear-gradient(90deg, var(--lab-primary-dim) 0%, transparent 100%);
  border: 1px solid var(--lab-border-strong);
  border-left: 3px solid var(--lab-primary);
  border-radius: 10px;
  padding: 14px 18px;
}

/* 切换账号时整块淡入：数据换了要有个视觉确认 */
.detail-block {
  animation: fade-in 0.22s ease-out;
}
@keyframes fade-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
</style>
