// Провайдер голоса по config.yaml (TECH-SPEC 5.8): stt и tts — независимо, каждый своим провайдером, адресом, моделью и
// ключом. Сменить провайдера — поправить config.yaml и перезапустить шлюз; код не меняется.
//
// Здесь — всё, что о конкретном провайдере нужно знать выше него (шлюзу, «статус», stg doctor): фабрика, голос и где он
// задаётся, сколько словаря уходит провайдеру. Каждый switch — с проверкой полноты: третий провайдер без своей ветки —
// ошибка компиляции, а не молча неверная строка.

import { KEYTERMS_FAST_LIMIT, type SttConfig, type TtsConfig } from './config.js';
import { ElevenLabsSpeechToText, ElevenLabsTextToSpeech } from './elevenlabs.js';
import { OPENAI_PROMPT_MAX_CHARS, OpenAiSpeechToText, OpenAiTextToSpeech, vocabularyPromptTerms } from './openai.js';
import { unknownProvider, type SpeechToText, type TextToSpeech } from './voice-provider.js';

export function createSpeechToText(cfg: SttConfig): SpeechToText {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAiSpeechToText({ baseUrl: cfg.base_url, model: cfg.model });
    case 'elevenlabs':
      return new ElevenLabsSpeechToText({ baseUrl: cfg.base_url, model: cfg.model });
    default:
      return unknownProvider(cfg);
  }
}

export function createTextToSpeech(cfg: TtsConfig): TextToSpeech {
  switch (cfg.provider) {
    case 'openai':
      return new OpenAiTextToSpeech({ baseUrl: cfg.base_url, model: cfg.model, instructions: cfg.instructions });
    case 'elevenlabs':
      return new ElevenLabsTextToSpeech({ baseUrl: cfg.base_url, model: cfg.model, outputFormat: cfg.output_format });
    default:
      return unknownProvider(cfg);
  }
}

/** Голос синтеза из настроек: openai — tts.voice, elevenlabs — tts.voice_id; null — не задан. */
export function ttsVoice(cfg: TtsConfig): string | null {
  switch (cfg.provider) {
    case 'openai':
      return cfg.voice;
    case 'elevenlabs':
      return cfg.voice_id;
    default:
      return unknownProvider(cfg);
  }
}

/** Где в config.yaml задаётся голос — для «что сделать». */
export function ttsVoiceField(cfg: TtsConfig): string {
  switch (cfg.provider) {
    case 'openai':
      return 'tts.voice';
    case 'elevenlabs':
      return 'tts.voice_id';
    default:
      return unknownProvider(cfg);
  }
}

/** Где взять голос — для «что сделать» stg doctor, когда голос не задан. */
export function ttsVoiceHint(cfg: TtsConfig): string {
  switch (cfg.provider) {
    case 'openai':
      return 'один из стандартных голосов OpenAI, например alloy';
    case 'elevenlabs':
      return 'голос из библиотеки ElevenLabs';
    default:
      return unknownProvider(cfg);
  }
}

/** Словарь распознавания глазами провайдера: сколько терминов задано и сколько уходит в запрос. */
export interface SttVocabularyUse {
  /** Терминов в config.yaml (stt.vocabulary). */
  terms: number;
  /** Сколько из них уходит провайдеру (у openai prompt ограничен по длине — остальное не отправляется). */
  sent: number;
  /** Запрос медленнее из-за размера словаря (у ElevenLabs больше 100 терминов — не быстрее 20 с). */
  slow: boolean;
  /** Оговорка словами для «статус» и stg doctor; null — оговорки нет. */
  note: string | null;
}

export function sttVocabularyUse(cfg: SttConfig): SttVocabularyUse {
  const terms = cfg.vocabulary.length;
  switch (cfg.provider) {
    case 'openai': {
      const sent = vocabularyPromptTerms(cfg.vocabulary).length;
      return {
        terms,
        sent,
        slow: false,
        note: sent < terms ? `в prompt уходит ${sent} из ${terms} терминов: предел ${OPENAI_PROMPT_MAX_CHARS} знаков` : null,
      };
    }
    case 'elevenlabs': {
      const slow = terms > KEYTERMS_FAST_LIMIT;
      return { terms, sent: terms, slow, note: slow ? `больше ${KEYTERMS_FAST_LIMIT} — запрос не быстрее 20 с` : null };
    }
    default:
      return unknownProvider(cfg);
  }
}
