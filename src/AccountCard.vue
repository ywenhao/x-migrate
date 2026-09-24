<script setup vapor lang="ts">
import { useI18n } from 'vue-i18n'
import type { AccountView } from './types'

type Role = 'source' | 'target'

const props = defineProps<{
  role: Role
  connection: { account: AccountView } | null
  connecting: Role | null
  taskActive: boolean
  curlMessage: string
  curlInvalid: boolean
}>()
const emit = defineEmits<{ parse: []; connect: []; disconnect: [] }>()
const curl = defineModel<string>('curl', { required: true })
const authToken = defineModel<string>('authToken', { required: true })
const ct0 = defineModel<string>('ct0', { required: true })
const { t } = useI18n()
</script>

<template>
  <article class="account-card">
    <div class="card-top">
      <span class="account-role">{{
        t(props.role === 'source' ? 'sourceAccount' : 'targetAccount')
      }}</span>
      <span :class="['account-tag', props.role === 'source' ? 'source-tag' : 'target-tag']">
        {{ t(props.role === 'source' ? 'oldAccount' : 'newAccount') }}
      </span>
    </div>

    <template v-if="props.connection">
      <div class="connected-profile">
        <img
          v-if="props.connection.account.avatarUrl"
          :src="props.connection.account.avatarUrl"
          alt=""
          referrerpolicy="no-referrer"
        />
        <span v-else class="avatar-fallback">{{ props.connection.account.name.slice(0, 1) }}</span>
        <div>
          <strong>{{ props.connection.account.name }}</strong>
          <small>@{{ props.connection.account.screenName }}</small>
        </div>
      </div>
      <div class="connected-line"><span class="check-dot">✓</span> {{ t('verified') }}</div>
      <div class="connected-line">
        {{
          t('followingTotal', { count: props.connection.account.followingCount ?? t('afterScan') })
        }}
      </div>
      <button
        class="text-button"
        type="button"
        :disabled="props.taskActive"
        @click="emit('disconnect')"
      >
        {{ t('disconnect') }}
      </button>
    </template>

    <form v-else @submit.prevent="emit('connect')">
      <label :for="`${props.role}-curl`">{{ t('extractCookie') }}</label>
      <textarea
        :id="`${props.role}-curl`"
        v-model="curl"
        rows="3"
        autocomplete="off"
        spellcheck="false"
        :placeholder="
          t(props.role === 'source' ? 'sourceCurlPlaceholder' : 'targetCurlPlaceholder')
        "
      ></textarea>
      <button class="parse-button" type="button" :disabled="!curl.trim()" @click="emit('parse')">
        {{ t('parseCurl') }}
      </button>
      <p
        v-if="props.curlMessage"
        :class="['curl-message', { invalid: props.curlInvalid }]"
        role="status"
      >
        {{ t(props.curlMessage) }}
      </p>
      <div class="field-divider">{{ t('manualEntry') }}</div>
      <label :for="`${props.role}-auth`">auth_token</label>
      <input
        :id="`${props.role}-auth`"
        v-model="authToken"
        type="password"
        autocomplete="off"
        spellcheck="false"
        :placeholder="
          t(props.role === 'source' ? 'sourceAuthPlaceholder' : 'targetAuthPlaceholder')
        "
        :required="!curl.trim()"
      />
      <label :for="`${props.role}-ct0`">ct0</label>
      <input
        :id="`${props.role}-ct0`"
        v-model="ct0"
        type="password"
        autocomplete="off"
        spellcheck="false"
        :placeholder="t(props.role === 'source' ? 'sourceCt0Placeholder' : 'targetCt0Placeholder')"
        :required="!curl.trim()"
      />
      <button class="button button-dark full" type="submit" :disabled="props.connecting !== null">
        {{
          props.connecting === props.role
            ? t('verifying')
            : t(props.role === 'source' ? 'connectOld' : 'connectNew')
        }}
      </button>
    </form>
  </article>
</template>
