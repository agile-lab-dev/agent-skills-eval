#!/usr/bin/env python3
"""Unit tests for generate_report.py's HTML rendering helpers.

Run with: uv run python3 .agents/skills/skill-creator/scripts/test_generate_report.py
"""

import unittest

import generate_report as gr


SAMPLE_DATA = {
    "original_description": "Do the thing when asked.",
    "best_description": "Do the thing precisely when asked.",
    "best_score": "3/3",
    "best_test_score": "1/1",
    "iterations_run": 2,
    "train_size": 3,
    "test_size": 1,
    "history": [
        {
            "iteration": 1,
            "description": "Do the thing when asked.",
            "train_passed": 1,
            "test_passed": 0,
            "train_results": [
                {"query": "please do the thing", "should_trigger": True, "pass": True, "triggers": 3, "runs": 3},
                {"query": "unrelated request", "should_trigger": False, "pass": False, "triggers": 3, "runs": 3},
            ],
            "test_results": [
                {"query": "held out query", "should_trigger": True, "pass": False, "triggers": 1, "runs": 3},
            ],
        },
        {
            "iteration": 2,
            "description": "Do the thing precisely when asked.",
            "train_passed": 2,
            "test_passed": 1,
            "train_results": [
                {"query": "please do the thing", "should_trigger": True, "pass": True, "triggers": 3, "runs": 3},
                {"query": "unrelated request", "should_trigger": False, "pass": True, "triggers": 0, "runs": 3},
            ],
            "test_results": [
                {"query": "held out query", "should_trigger": True, "pass": True, "triggers": 3, "runs": 3},
            ],
        },
    ],
}


class TestExtractQueries(unittest.TestCase):
    def test_splits_train_and_test(self):
        train, test = gr._extract_queries(SAMPLE_DATA["history"])
        self.assertEqual([q["query"] for q in train], ["please do the thing", "unrelated request"])
        self.assertEqual([q["query"] for q in test], ["held out query"])

    def test_empty_history(self):
        train, test = gr._extract_queries([])
        self.assertEqual(train, [])
        self.assertEqual(test, [])


class TestAggregateRuns(unittest.TestCase):
    def test_counts_correct_for_positive_and_negative(self):
        results = [
            {"should_trigger": True, "triggers": 2, "runs": 3},
            {"should_trigger": False, "triggers": 1, "runs": 3},
        ]
        correct, total = gr._aggregate_runs(results)
        self.assertEqual((correct, total), (2 + 2, 6))


class TestScoreClass(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(gr._score_class(9, 10), "score-good")
        self.assertEqual(gr._score_class(6, 10), "score-ok")
        self.assertEqual(gr._score_class(2, 10), "score-bad")
        self.assertEqual(gr._score_class(0, 0), "score-bad")


class TestRenderQueryCell(unittest.TestCase):
    def test_pass_and_fail(self):
        passed = gr.render_query_cell({"pass": True, "triggers": 3, "runs": 3})
        failed = gr.render_query_cell({"pass": False, "triggers": 0, "runs": 3})
        self.assertIn('class="result pass"', passed)
        self.assertIn("✓", passed)
        self.assertIn('class="result fail"', failed)
        self.assertIn("✗", failed)

    def test_css_extra_is_prefixed(self):
        cell = gr.render_query_cell({"pass": True, "triggers": 1, "runs": 1}, "test-result")
        self.assertIn('class="result test-result pass"', cell)


class TestGenerateHtml(unittest.TestCase):
    def test_contains_query_column_headers(self):
        out = gr.generate_html(SAMPLE_DATA)
        self.assertIn("please do the thing", out)
        self.assertIn("held out query", out)
        self.assertIn('class="test-col positive-col"', out)

    def test_highlights_best_row(self):
        out = gr.generate_html(SAMPLE_DATA)
        # Iteration 2 has the best test score, so it should get the best-row class.
        self.assertIn('<tr class="best-row">\n                <td>2</td>', out)

    def test_auto_refresh_meta_tag(self):
        out = gr.generate_html(SAMPLE_DATA, auto_refresh=True)
        self.assertIn('<meta http-equiv="refresh" content="5">', out)
        out_no_refresh = gr.generate_html(SAMPLE_DATA)
        self.assertNotIn("http-equiv", out_no_refresh)

    def test_skill_name_prefixes_title(self):
        out = gr.generate_html(SAMPLE_DATA, skill_name="My Skill")
        self.assertIn("My Skill — Skill Description Optimization", out)


if __name__ == "__main__":
    unittest.main()
